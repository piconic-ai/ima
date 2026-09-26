// Package access signs in to an ima server behind Cloudflare Access with
// cloudflared, so that sharing a file stays a single command.
package access

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"time"
)

// Header is where Access looks for the token of a signed-in user.
const Header = "Cf-Access-Token"

// ErrNoCloudflared means cloudflared is not installed.
var ErrNoCloudflared = errors.New("cloudflared is not installed")

// Cloudflared gets the Access token of whoever runs ima, signing in with the
// browser when there is no valid token yet. cloudflared keeps the token, so
// the browser opens only once per Access session.
type Cloudflared struct {
	// Progress receives what cloudflared prints while signing in, such as the
	// URL to open when the browser does not open by itself.
	Progress io.Writer
	// Run runs cloudflared. Tests replace it.
	Run func(ctx context.Context, stdout, stderr io.Writer, args ...string) error
	Now func() time.Time
}

func runCloudflared(ctx context.Context, stdout, stderr io.Writer, args ...string) error {
	path, err := exec.LookPath("cloudflared")
	if err != nil {
		return ErrNoCloudflared
	}
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Stdout, cmd.Stderr = stdout, stderr
	return cmd.Run()
}

// Token returns a token for the Access application at app, e.g. https://ima.example.com
func (c *Cloudflared) Token(ctx context.Context, app string) (string, error) {
	run := c.Run
	if run == nil {
		run = runCloudflared
	}
	now := time.Now
	if c.Now != nil {
		now = c.Now
	}
	progress := c.Progress
	if progress == nil {
		progress = io.Discard
	}

	cached := func() (string, error) {
		var out bytes.Buffer
		if err := run(ctx, &out, io.Discard, "access", "token", "-app="+app); err != nil {
			return "", err
		}
		return strings.TrimSpace(out.String()), nil
	}
	// A token that is about to expire would not last through connecting.
	if token, err := cached(); errors.Is(err, ErrNoCloudflared) {
		return "", err
	} else if err == nil && usable(token, now()) {
		return token, nil
	}

	fmt.Fprintf(progress, "%s is behind Cloudflare Access. Signing in with cloudflared…\n", app)
	// --quiet keeps the token itself off the terminal.
	if err := run(ctx, progress, progress, "access", "login", "--quiet", "--auto-close", app); err != nil {
		return "", fmt.Errorf("cloudflared could not sign in to %s: %w", app, err)
	}
	token, err := cached()
	if err != nil || !usable(token, now()) {
		return "", fmt.Errorf("cloudflared signed in to %s but returned no usable token", app)
	}
	return token, nil
}

type claims struct {
	Email string `json:"email"`
	Exp   int64  `json:"exp"`
}

// parse reads the claims of a JWT without verifying it. Access verifies the
// token; we only look at it to decide whether to sign in and what to show.
func parse(token string) (claims, bool) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return claims{}, false
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return claims{}, false
	}
	var c claims
	if err := json.Unmarshal(payload, &c); err != nil {
		return claims{}, false
	}
	return c, true
}

func usable(token string, now time.Time) bool {
	c, ok := parse(token)
	return ok && c.Exp > now.Add(time.Minute).Unix()
}

// Email is the email of the user a token was issued to, or "".
func Email(token string) string {
	c, _ := parse(token)
	return c.Email
}
