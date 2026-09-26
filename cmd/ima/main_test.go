package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

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

func TestAccessHeader(t *testing.T) {
	tests := []struct {
		env     map[string]string
		want    http.Header
		wantErr string
	}{
		{env: nil, want: nil},
		{
			env:  map[string]string{"IMA_ACCESS_CLIENT_ID": "id.access", "IMA_ACCESS_CLIENT_SECRET": "secret"},
			want: http.Header{"Cf-Access-Client-Id": {"id.access"}, "Cf-Access-Client-Secret": {"secret"}},
		},
		{env: map[string]string{"IMA_ACCESS_CLIENT_ID": "id.access"}, wantErr: "set both"},
		{env: map[string]string{"IMA_ACCESS_CLIENT_SECRET": "secret"}, wantErr: "set both"},
	}
	for _, tt := range tests {
		got, err := accessHeader(func(k string) string { return tt.env[k] })
		if tt.wantErr != "" {
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Errorf("accessHeader(%v) err = %v", tt.env, err)
			}
			continue
		}
		if err != nil || !reflect.DeepEqual(got, tt.want) {
			t.Errorf("accessHeader(%v) = %v, %v", tt.env, got, err)
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

func TestStartKeepsServiceToken(t *testing.T) {
	server := accessServer(t, userToken)
	signIn := func(context.Context, string) (string, error) {
		t.Fatal("signed in although a service token was given")
		return "", nil
	}
	header := http.Header{"Cf-Access-Client-Id": {"id"}, "Cf-Access-Client-Secret": {"bad"}}
	_, err := start(context.Background(), signIn, session.Options{File: tempFile(t), Server: server.URL, Header: header})
	if err == nil || !strings.Contains(err.Error(), "did not accept the service token in IMA_ACCESS_CLIENT_ID") {
		t.Fatalf("err = %v", err)
	}
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
	if err == nil || !strings.Contains(err.Error(), "Install cloudflared") || !strings.Contains(err.Error(), "IMA_ACCESS_CLIENT_ID") {
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
