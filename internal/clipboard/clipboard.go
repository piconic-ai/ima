// Package clipboard copies text with the platform's clipboard command.
package clipboard

import (
	"os/exec"
	"runtime"
	"strings"
)

var commands = map[string][][]string{
	"darwin":  {{"pbcopy"}},
	"windows": {{"clip"}},
	"linux": {
		{"wl-copy"},
		{"xclip", "-selection", "clipboard"},
		{"xsel", "--clipboard", "--input"},
	},
}

// Copy is best effort: it returns false when no clipboard tool is available.
func Copy(text string) bool {
	for _, argv := range commands[runtime.GOOS] {
		cmd := exec.Command(argv[0], argv[1:]...)
		cmd.Stdin = strings.NewReader(text)
		if cmd.Run() == nil {
			return true
		}
	}
	return false
}
