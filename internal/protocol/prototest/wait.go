package prototest

import (
	"testing"
	"time"
)

// WaitFor polls cond until it holds, failing the test after timeout.
func WaitFor(t testing.TB, timeout time.Duration, cond func() bool, what string) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}
