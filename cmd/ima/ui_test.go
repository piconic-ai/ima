package main

import (
	"strings"
	"testing"

	"github.com/piconic-ai/ima/internal/protocol"
)

func TestUIWithoutTerminal(t *testing.T) {
	var out strings.Builder
	u := newUI(&out, false, false)
	u.setStatus(protocol.StatusConnected) // not shown before sharing
	u.signIn("ima.example.com", "https://ima.example.com/cdn-cgi/access/cli?token=abc")
	u.signedIn("k@example.com")
	u.sharing("notes.md", "https://ima.example.com/r/AAAA#key", true)
	u.setPeople([]string{"Alice"})
	u.setPeople([]string{"Alice"}) // unchanged
	u.setStatus(protocol.StatusDisconnected)
	u.setStatus(protocol.StatusConnected)
	u.setPeople([]string{"Alice", "Bob"})
	u.stopLive()
	u.setPeople(nil) // not shown after stopping
	u.saving("notes.md")
	u.saved("notes.md")

	want := `
  Sign in to ima.example.com
  Your browser opened. Sign in there, then come back here.

  If it did not open, use this link:
  https://ima.example.com/cdn-cgi/access/cli?token=abc

  ✓ Signed in as k@example.com

  notes.md is ready to write together.

  Send this link to the people you want to invite:
    https://ima.example.com/r/AAAA#key
    Copied to your clipboard.

  Press Ctrl+C when you are done. Everything is saved to notes.md.

  ● Just you so far
  ● Alice is here
  ○ Offline. Reconnecting…
  ● Alice is here
  ● Alice and Bob are here

  Saving notes.md…
  ✓ Saved notes.md. The link no longer works.

`
	if out.String() != want {
		t.Fatalf("got:\n%s\nwant:\n%s", out.String(), want)
	}
	if strings.Contains(out.String(), "\x1b[") {
		t.Fatal("escape codes outside a terminal")
	}
}

func TestUIOnTerminal(t *testing.T) {
	var out strings.Builder
	u := newUI(&out, true, false)
	u.sharing("notes.md", "https://ima.example.com/r/AAAA#key", false)
	u.setStatus(protocol.StatusConnected)
	u.stopLive()
	got := out.String()
	for _, want := range []string{
		"\x1b[1mnotes.md is ready to write together.\x1b[0m",
		"    \x1b[36;4mhttps://ima.example.com/r/AAAA#key\x1b[0m\n",
		// The live line is rewritten in place.
		"\r\x1b[2K  \x1b[33m○\x1b[0m Connecting…",
		"\r\x1b[2K  \x1b[32m●\x1b[0m Just you so far\n",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in %q", want, got)
		}
	}
	if strings.Contains(got, "clipboard") {
		t.Error("claims the link was copied")
	}
}

func TestUIWithoutColor(t *testing.T) {
	var out strings.Builder
	u := newUI(&out, true, true) // NO_COLOR
	u.sharing("notes.md", "https://ima.example.com/r/AAAA#key", true)
	u.saved("notes.md")
	if got := out.String(); strings.Contains(got, "\x1b[1m") || strings.Contains(got, "\x1b[3") {
		t.Fatalf("colors despite NO_COLOR: %q", got)
	}
}

func TestWhoIsHere(t *testing.T) {
	tests := []struct {
		names []string
		want  string
	}{
		{nil, "Just you so far"},
		{[]string{"Alice"}, "Alice is here"},
		{[]string{"Alice", "Bob"}, "Alice and Bob are here"},
		{[]string{"Alice", "Bob", "Carol"}, "Alice, Bob and Carol are here"},
		{[]string{"Alice", "Bob", "Carol", "Dave"}, "Alice, Bob and 2 others are here"},
	}
	for _, tt := range tests {
		if got := whoIsHere(tt.names); got != tt.want {
			t.Errorf("whoIsHere(%q) = %q, want %q", tt.names, got, tt.want)
		}
	}
}

func TestHostOf(t *testing.T) {
	for in, want := range map[string]string{
		"https://ima-lab.piconic.ai":  "ima-lab.piconic.ai",
		"https://ima-lab.piconic.ai/": "ima-lab.piconic.ai",
		"http://localhost:8787":       "localhost:8787",
	} {
		if got := hostOf(in); got != want {
			t.Errorf("hostOf(%q) = %q", in, got)
		}
	}
}
