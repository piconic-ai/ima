package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/piconic-ai/ima/internal/access"
	"github.com/piconic-ai/ima/internal/session"
)

func TestRunArgs(t *testing.T) {
	tests := []struct {
		args   []string
		code   int
		stdout string
		stderr string
	}{
		{args: []string{"--help"}, code: 0, stdout: "Usage: ima <file>"},
		{args: []string{"-h"}, code: 0, stdout: "IMA_SERVER"},
		{args: []string{"--version"}, code: 0, stdout: "dev"},
		{args: nil, code: 2, stderr: "Usage: ima <file>"},
		{args: []string{"a.md", "b.md"}, code: 2, stderr: "Usage: ima <file>"},
		{args: []string{"does-not-exist.md"}, code: 1, stderr: "no such file: does-not-exist.md"},
		{args: []string{"."}, code: 1, stderr: "no such file: ."},
	}
	for _, tt := range tests {
		var stdout, stderr strings.Builder
		code := run(tt.args, &stdout, &stderr)
		if code != tt.code || !strings.Contains(stdout.String(), tt.stdout) || !strings.Contains(stderr.String(), tt.stderr) {
			t.Errorf("run(%q) = %d\nstdout: %s\nstderr: %s", tt.args, code, stdout.String(), stderr.String())
		}
	}
}

// accessServer stands in for an ima server behind Cloudflare Access: without
// a valid token, Access sends requests to its login page.
func accessServer(t *testing.T, valid string) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/cdn-cgi/access/"):
			_, _ = w.Write([]byte("<html>Sign in</html>"))
		case r.Header.Get("Cf-Access-Token") != valid:
			http.Redirect(w, r, "/cdn-cgi/access/login/ima", http.StatusFound)
		default:
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"id":"AAAAAAAAAAAAAAAAAAAAAA","hostToken":"host-token"}`))
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func tempFile(t *testing.T) string {
	t.Helper()
	file := filepath.Join(t.TempDir(), "notes.md")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	return file
}

// A JWT whose payload is {"email":"k@example.com"}.
const userToken = "h.eyJlbWFpbCI6ImtAZXhhbXBsZS5jb20ifQ.s"

func TestStartSignsInToAccess(t *testing.T) {
	server := accessServer(t, userToken)
	var signedIn string
	signIn := func(_ context.Context, app string) (string, error) {
		signedIn = app
		return userToken, nil
	}
	s, err := start(context.Background(), signIn, session.Options{File: tempFile(t), Server: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Stop()
	if signedIn != server.URL {
		t.Fatalf("signed in to %q", signedIn)
	}
}

func TestStartDoesNotSignInWithoutAccess(t *testing.T) {
	server := accessServer(t, "")
	signIn := func(context.Context, string) (string, error) {
		t.Fatal("signed in without Access")
		return "", nil
	}
	s, err := start(context.Background(), signIn, session.Options{File: tempFile(t), Server: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Stop()
}

func TestStartExplainsRejectedSignIn(t *testing.T) {
	server := accessServer(t, "a token Access still accepts")
	signIn := func(context.Context, string) (string, error) { return userToken, nil }
	_, err := start(context.Background(), signIn, session.Options{File: tempFile(t), Server: server.URL})
	if err == nil || !strings.Contains(err.Error(), "did not accept your sign-in") || !strings.Contains(err.Error(), "rm ~/.cloudflared/*-token") {
		t.Fatalf("err = %v", err)
	}
}

func TestStartExplainsMissingCloudflared(t *testing.T) {
	server := accessServer(t, userToken)
	signIn := func(context.Context, string) (string, error) { return "", access.ErrNoCloudflared }
	_, err := start(context.Background(), signIn, session.Options{File: tempFile(t), Server: server.URL})
	if err == nil || !strings.Contains(err.Error(), "Install cloudflared") {
		t.Fatalf("err = %v", err)
	}
}

func TestGravatarURL(t *testing.T) {
	// Same hash as the web editor's test: sha256("test@example.com").
	want := "https://gravatar.com/avatar/973dfe463ec85785f5f95af5ba3906eedb2d931c24e69824a89ea65dba4e813b?s=64&d=404"
	if got := gravatarURL(" Test@Example.com "); got != want {
		t.Fatalf("gravatarURL = %q", got)
	}
}

func TestWithSignInLimit(t *testing.T) {
	// Waits like cloudflared does for someone who clicked Deny.
	waitForever := func(ctx context.Context, _ string) (string, error) {
		<-ctx.Done()
		return "", ctx.Err()
	}

	t.Run("signed in", func(t *testing.T) {
		got, err := withSignInLimit(context.Background(), time.Minute, "https://ima.example.com", func(context.Context, string) (string, error) { return userToken, nil })
		if err != nil || got != userToken {
			t.Fatalf("= %q, %v", got, err)
		}
	})
	t.Run("cancelled with Ctrl+C", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		time.AfterFunc(10*time.Millisecond, cancel)
		if _, err := withSignInLimit(ctx, time.Minute, "https://ima.example.com", waitForever); !errors.Is(err, errSignInCancelled) {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("out of time", func(t *testing.T) {
		if _, err := withSignInLimit(context.Background(), 10*time.Millisecond, "https://ima.example.com", waitForever); !errors.Is(err, errSignInTimedOut) {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("failed", func(t *testing.T) {
		failed := errors.New("could not sign in")
		fail := func(context.Context, string) (string, error) { return "", failed }
		if _, err := withSignInLimit(context.Background(), time.Minute, "https://ima.example.com", fail); !errors.Is(err, failed) {
			t.Fatalf("err = %v", err)
		}
	})
}
