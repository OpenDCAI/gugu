package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	projection "github.com/OpenDCAI/gugu/projection-media"
)

func main() {
	encoding := projection.EncoderConfig{}
	flag.StringVar(&encoding.Executable, "ffmpeg", "", "absolute host-resolved FFmpeg executable")
	flag.IntVar(&encoding.Width, "width", 0, "encoded frame width")
	flag.IntVar(&encoding.Height, "height", 0, "encoded frame height")
	flag.IntVar(&encoding.FPS, "fps", 0, "encoded frames per second")
	flag.IntVar(&encoding.Bitrate, "bitrate", 0, "encoded bits per second")
	stun := flag.String("stun", "", "host-configured STUN discovery URL")
	loopback := flag.Bool("test-loopback", false, "include loopback candidates in isolated native tests")
	flag.Parse()
	config := projection.Config{Loopback: *loopback}
	if *stun != "" {
		config.STUN = []string{*stun}
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := projection.ServeMedia(ctx, config, encoding, os.Stdin, os.Stdout); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
