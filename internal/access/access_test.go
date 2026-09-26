package access

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"
)

var now = time.Unix(1_800_000_000, 0)

func jwt(email string, exp time.Time) string {
	payload := fmt.Sprintf(`{"email":%q,"exp":%d}`, email, exp.Unix())
	return "eyJhbGciOiJSUzI1NiJ9." + base64.RawURLEncoding.EncodeToString([]byte(payload)) + ".sig"
}

// fakeCloudflared keeps a token like cloudflared does and records its calls.
type fakeCloudflared struct {
	token    string // what `access token` prints; "" means not signed in
	login    string // what `access login` stores
	loginErr error
	calls    []string
}

func (f *fakeCloudflared) run(_ context.Context, stdout, stderr io.Writer, args ...string) error {
	f.calls = append(f.calls, strings.Join(args, " "))
	switch args[1] {
	case "token":
		if f.token == "" {
			fmt.Fprintln(stderr, "Unable to find token for provided application.")
			return errors.New("exit status 1")
		}
		fmt.Fprintln(stdout, f.token)
	case "login":
		fmt.Fprintln(stderr, "A browser window should have opened at the following URL:")
		if f.loginErr != nil {
			return f.loginErr
		}
		f.token = f.login
	}
	return nil
}

func TestTokenUsesSignedInToken(t *testing.T) {
	token := jwt("k@example.com", now.Add(time.Hour))
	f := &fakeCloudflared{token: token}
	got, err := (&Cloudflared{Run: f.run, Now: func() time.Time { return now }}).Token(context.Background(), "https://ima.example.com")
	if err != nil || got != token {
		t.Fatalf("Token = %q, %v", got, err)
	}
	if want := []string{"access token -app=https://ima.example.com"}; fmt.Sprint(f.calls) != fmt.Sprint(want) {
		t.Fatalf("calls = %q", f.calls)
	}
}

func TestTokenSignsInWhenNeeded(t *testing.T) {
	fresh := jwt("k@example.com", now.Add(24*time.Hour))
	for name, f := range map[string]*fakeCloudflared{
		"not signed in":   {login: fresh},
		"expired":         {token: jwt("k@example.com", now.Add(-time.Hour)), login: fresh},
		"about to expire": {token: jwt("k@example.com", now.Add(10*time.Second)), login: fresh},
		"not a JWT":       {token: "garbage", login: fresh},
	} {
		t.Run(name, func(t *testing.T) {
			var progress bytes.Buffer
			c := &Cloudflared{Run: f.run, Now: func() time.Time { return now }, Progress: &progress}
			got, err := c.Token(context.Background(), "https://ima.example.com")
			if err != nil || got != fresh {
				t.Fatalf("Token = %q, %v", got, err)
			}
			if !strings.Contains(fmt.Sprint(f.calls), "access login --quiet --auto-close https://ima.example.com") {
				t.Fatalf("calls = %q", f.calls)
			}
			// The user sees where to sign in, but never the token.
			if !strings.Contains(progress.String(), "browser window") || strings.Contains(progress.String(), fresh) {
				t.Fatalf("progress = %q", progress.String())
			}
		})
	}
}

func TestTokenReportsFailedSignIn(t *testing.T) {
	f := &fakeCloudflared{loginErr: errors.New("exit status 1")}
	_, err := (&Cloudflared{Run: f.run, Now: func() time.Time { return now }}).Token(context.Background(), "https://ima.example.com")
	if err == nil || !strings.Contains(err.Error(), "could not sign in to https://ima.example.com") {
		t.Fatalf("err = %v", err)
	}
}

func TestTokenWithoutCloudflared(t *testing.T) {
	run := func(context.Context, io.Writer, io.Writer, ...string) error { return ErrNoCloudflared }
	_, err := (&Cloudflared{Run: run}).Token(context.Background(), "https://ima.example.com")
	if !errors.Is(err, ErrNoCloudflared) {
		t.Fatalf("err = %v", err)
	}
}

func TestEmail(t *testing.T) {
	if got := Email(jwt("k@example.com", now)); got != "k@example.com" {
		t.Fatalf("Email = %q", got)
	}
	for _, token := range []string{"", "a.b", "a.!!!.c", "a." + base64.RawURLEncoding.EncodeToString([]byte("[]")) + ".c"} {
		if got := Email(token); got != "" {
			t.Fatalf("Email(%q) = %q", token, got)
		}
	}
}
