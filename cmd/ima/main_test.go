package main

import (
	"net/http"
	"reflect"
	"strings"
	"testing"
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

func TestStatusLine(t *testing.T) {
	var out strings.Builder
	l := &statusLine{out: &out, status: "connecting"}
	l.setStatus("connected") // not shown before start
	l.start()
	l.setPeers(1)
	l.setPeers(1) // unchanged
	l.setPeers(2)
	l.stop()
	l.setPeers(0) // not shown after stop
	want := "● connected · waiting for others\n● connected · 1 other here\n● connected · 2 others here\n"
	if out.String() != want {
		t.Fatalf("got %q", out.String())
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
