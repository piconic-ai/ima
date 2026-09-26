package main

import (
	"fmt"
	"io"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/piconic-ai/ima/internal/protocol"
)

// ui is what the person sharing the file reads. They are not necessarily an
// engineer, so it avoids jargon, puts the link to send first, and says what
// to do next. Everything is indented by two spaces and grouped by blank lines.
//
// The last line shows who is here and is rewritten in place on a terminal.
type ui struct {
	out   io.Writer
	tty   bool
	color bool
	// width is the terminal's width in columns, or 0 if unknown.
	width func() int

	mu       sync.Mutex
	live     bool
	status   protocol.Status
	people   []string
	lastLine string
	// signInRows is how many terminal rows the sign-in block takes, so it can
	// be cleared once signed in.
	signInRows int
}

func newUI(out io.Writer, tty, noColor bool, width func() int) *ui {
	if width == nil {
		width = func() int { return 0 }
	}
	return &ui{out: out, tty: tty, color: tty && !noColor, width: width, status: protocol.StatusConnecting}
}

func (u *ui) paint(code, s string) string {
	if !u.color {
		return s
	}
	return "\x1b[" + code + "m" + s + "\x1b[0m"
}

func (u *ui) bold(s string) string   { return u.paint("1", s) }
func (u *ui) dim(s string) string    { return u.paint("2", s) }
func (u *ui) green(s string) string  { return u.paint("32", s) }
func (u *ui) yellow(s string) string { return u.paint("33", s) }
func (u *ui) link(s string) string   { return u.paint("36;4", s) }

func (u *ui) print(lines ...string) {
	u.mu.Lock()
	defer u.mu.Unlock()
	for _, line := range lines {
		if line == "" {
			fmt.Fprintln(u.out)
		} else {
			fmt.Fprintln(u.out, "  "+line)
		}
	}
}

// signIn is shown while the browser is open to sign in.
func (u *ui) signIn(host, url string) {
	lines := []string{
		"",
		"Sign in to " + host,
		"Your browser opened. Sign in there, then come back here.",
		"",
		"If it did not open, use this link:",
		url,
	}
	u.print("", u.bold(lines[1]), lines[2], "", u.dim(lines[4]), u.dim(lines[5]))

	u.mu.Lock()
	defer u.mu.Unlock()
	u.signInRows = rows(lines, u.width())
}

// signedIn replaces the sign-in block, which is no longer needed.
func (u *ui) signedIn(email string) {
	u.mu.Lock()
	if u.tty && u.signInRows > 0 {
		// Up to where the block started, then clear to the end of the screen.
		fmt.Fprintf(u.out, "\x1b[%dA\r\x1b[J", u.signInRows)
	}
	u.signInRows = 0
	u.mu.Unlock()
	if email != "" {
		u.print("", u.green("✓")+" Signed in as "+email)
	}
}

// rows counts the terminal rows lines take once indented and wrapped at
// width columns. Lines are plain text; every character is one column wide.
func rows(lines []string, width int) int {
	n := 0
	for _, line := range lines {
		if line != "" {
			line = "  " + line
		}
		if l := utf8.RuneCountInString(line); width > 0 && l > width {
			n += (l + width - 1) / width
		} else {
			n++
		}
	}
	return n
}

// sharing shows the link to send, then starts the live line.
func (u *ui) sharing(file, url string, copied bool) {
	lines := []string{
		"",
		u.bold(file + " is ready to write together."),
		"",
		"Send this link to the people you want to invite:",
		"  " + u.link(url),
	}
	if copied {
		lines = append(lines, "  "+u.dim("Copied to your clipboard."))
	}
	lines = append(lines, "", u.dim("Press Ctrl+C when you are done. Everything is saved to "+file+"."), "")
	u.print(lines...)

	u.mu.Lock()
	defer u.mu.Unlock()
	u.live = true
	u.render()
}

func (u *ui) setStatus(s protocol.Status) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.status = s
	u.render()
}

func (u *ui) setPeople(names []string) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.people = names
	u.render()
}

// stopLive ends the live line, leaving its last state on screen.
func (u *ui) stopLive() {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.live && u.tty {
		fmt.Fprintln(u.out)
	}
	u.live = false
}

func (u *ui) saving(file string) {
	u.print("", "Saving "+file+"…")
}

func (u *ui) saved(file string) {
	u.print(u.green("✓")+" Saved "+file+". The link no longer works.", "")
}

// render redraws the live line. Callers hold u.mu.
func (u *ui) render() {
	if !u.live {
		return
	}
	line := u.liveLine()
	if line == u.lastLine {
		return
	}
	u.lastLine = line
	if u.tty {
		fmt.Fprint(u.out, "\r\x1b[2K  "+line)
	} else {
		fmt.Fprintln(u.out, "  "+line)
	}
}

func (u *ui) liveLine() string {
	switch u.status {
	case protocol.StatusConnected:
		return u.green("●") + " " + whoIsHere(u.people)
	case protocol.StatusDisconnected:
		return u.yellow("○") + " Offline. Reconnecting…"
	case protocol.StatusClosed:
		return u.yellow("○") + " Closed."
	default:
		return u.yellow("○") + " Connecting…"
	}
}

// whoIsHere names up to three people and counts the rest, so the line stays short.
func whoIsHere(names []string) string {
	switch n := len(names); {
	case n == 0:
		return "Just you so far"
	case n == 1:
		return names[0] + " is here"
	case n == 2:
		return names[0] + " and " + names[1] + " are here"
	case n == 3:
		return names[0] + ", " + names[1] + " and " + names[2] + " are here"
	default:
		return fmt.Sprintf("%s, %s and %d others are here", names[0], names[1], n-2)
	}
}

// hostOf is the server as people know it: its host name.
func hostOf(server string) string {
	s := strings.TrimPrefix(strings.TrimPrefix(server, "https://"), "http://")
	return strings.TrimRight(s, "/")
}
