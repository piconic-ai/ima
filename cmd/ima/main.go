// Command ima shares a local Markdown file and co-edits it with others in their browser.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"os/user"
	"path/filepath"
	"runtime/debug"
	"strings"
	"syscall"

	"github.com/piconic-ai/ima/internal/access"
	"github.com/piconic-ai/ima/internal/clipboard"
	"github.com/piconic-ai/ima/internal/session"
	"golang.org/x/term"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = ""

// getVersion falls back to the module version, which `go install ...@vX.Y.Z` records.
func getVersion() string {
	if version != "" {
		return version
	}
	if info, ok := debug.ReadBuildInfo(); ok && info.Main.Version != "" && info.Main.Version != "(devel)" {
		return info.Main.Version
	}
	return "dev"
}

const defaultServer = "https://ima.piconic.ai"

const usage = `Usage: ima <file>

Share a local Markdown file and co-edit it with others in their browser.
Edits are written back to the file. Press Ctrl+C to finish.

Environment:
  IMA_SERVER                ima server URL (default: ` + defaultServer + `)
  IMA_ACCESS_CLIENT_ID      Cloudflare Access service token, for a server
  IMA_ACCESS_CLIENT_SECRET  behind Cloudflare Access

A server behind Cloudflare Access signs you in with cloudflared, unless a
service token is set.`

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(args []string, stdout, stderr io.Writer) int {
	if len(args) == 1 && (args[0] == "-h" || args[0] == "--help") {
		fmt.Fprintln(stdout, usage)
		return 0
	}
	if len(args) == 1 && (args[0] == "-v" || args[0] == "--version") {
		fmt.Fprintln(stdout, getVersion())
		return 0
	}
	if len(args) != 1 || args[0] == "" {
		fmt.Fprintln(stderr, usage)
		return 2
	}
	arg := args[0]
	file, err := filepath.Abs(arg)
	if err != nil {
		fmt.Fprintln(stderr, "ima:", err)
		return 1
	}
	if st, err := os.Stat(file); err != nil || st.IsDir() {
		fmt.Fprintf(stderr, "ima: no such file: %s\n", arg)
		return 1
	}

	server := os.Getenv("IMA_SERVER")
	if server == "" {
		server = defaultServer
	}
	header, err := accessHeader(os.Getenv)
	if err != nil {
		fmt.Fprintln(stderr, "ima:", err)
		return 2
	}
	out := newUI(stdout, isTerminal(stdout), os.Getenv("NO_COLOR") != "")

	signals := make(chan os.Signal, 2)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		<-signals
		cancel()
	}()

	cloudflared := &access.Cloudflared{OnSignIn: func(url string) { out.signIn(hostOf(server), url) }}
	signIn := func(ctx context.Context, app string) (string, error) {
		token, err := cloudflared.Token(ctx, app)
		if err == nil {
			out.signedIn(access.Email(token))
		}
		return token, err
	}
	s, err := start(ctx, signIn, session.Options{
		File:     file,
		Server:   server,
		Header:   header,
		Name:     username(),
		Watch:    true,
		OnStatus: out.setStatus,
		OnPeople: out.setPeople,
		OnError: func(err error) {
			if os.Getenv("IMA_DEBUG") != "" {
				fmt.Fprintln(stderr, "\nima:", err)
			}
		},
	})
	if err != nil {
		fmt.Fprintln(stderr, "ima:", err)
		return 1
	}

	out.sharing(arg, s.URL, clipboard.Copy(s.URL))

	<-ctx.Done()
	// A second signal gives up on saving.
	go func() {
		<-signals
		os.Exit(130)
	}()
	out.stopLive()
	out.saving(arg)
	if err := s.Stop(); err != nil {
		fmt.Fprintf(stderr, "ima: could not save %s: %v\n", arg, err)
		return 1
	}
	out.saved(arg)
	return 0
}

func isTerminal(w io.Writer) bool {
	f, ok := w.(*os.File)
	return ok && term.IsTerminal(int(f.Fd()))
}

func username() string {
	u, err := user.Current()
	if err != nil {
		return ""
	}
	return u.Username
}

// accessHeader reads the Cloudflare Access service token to send to a server
// behind Access.
func accessHeader(getenv func(string) string) (http.Header, error) {
	id, secret := getenv("IMA_ACCESS_CLIENT_ID"), getenv("IMA_ACCESS_CLIENT_SECRET")
	if id == "" && secret == "" {
		return nil, nil
	}
	if id == "" || secret == "" {
		return nil, errors.New("set both IMA_ACCESS_CLIENT_ID and IMA_ACCESS_CLIENT_SECRET")
	}
	return http.Header{"Cf-Access-Client-Id": {id}, "Cf-Access-Client-Secret": {secret}}, nil
}

// start shares the file, signing in with Cloudflare Access when the server is
// behind it and no service token was given.
func start(ctx context.Context, signIn func(context.Context, string) (string, error), opts session.Options) (*session.Session, error) {
	s, err := session.Start(ctx, opts)
	if !errors.Is(err, session.ErrBehindAccess) || opts.Header != nil {
		return s, err
	}
	token, err := signIn(ctx, opts.Server)
	if errors.Is(err, access.ErrNoCloudflared) {
		return nil, fmt.Errorf("%s is behind Cloudflare Access. Install cloudflared to sign in (for example, brew install cloudflared), or set IMA_ACCESS_CLIENT_ID and IMA_ACCESS_CLIENT_SECRET to a service token", opts.Server)
	}
	if err != nil {
		return nil, err
	}
	opts.Header = http.Header{access.Header: {token}}
	if email := access.Email(token); email != "" {
		opts.Avatar = gravatarURL(email)
	}
	return session.Start(ctx, opts)
}

// gravatarURL matches the web editor's: 404 for unknown emails, so others see initials.
func gravatarURL(email string) string {
	sum := sha256.Sum256([]byte(strings.ToLower(strings.TrimSpace(email))))
	return "https://gravatar.com/avatar/" + hex.EncodeToString(sum[:]) + "?s=64&d=404"
}
