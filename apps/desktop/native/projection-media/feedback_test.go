package projection

import (
	"bytes"
	"context"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
)

func TestIDRRefreshRetainsSourceAndRTPContinuity(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	config := testEncoderConfig(t)
	output := &capturedRTP{}
	video, err := StartVideoEncoder(ctx, config, output)
	if err != nil {
		t.Fatal(err)
	}
	defer video.Close()
	pixels := make([]byte, config.Width*config.Height*4)
	for i := 0; i < len(pixels); i += 4 {
		pixels[i+2] = 230
		pixels[i+3] = 255
	}
	first, err := video.WriteFrame(ctx, 41, pixels)
	if err != nil {
		t.Fatal(err)
	}
	address := &video.pixels[0]
	// The caller may reuse its own buffer as soon as WriteFrame returns.
	clear(pixels)
	for attempt := 0; attempt < 3; attempt++ {
		output.mu.Lock()
		before := len(output.packets)
		output.mu.Unlock()
		receipt, refreshErr := video.RefreshFrame(ctx)
		if refreshErr != nil || receipt.Sequence != 41 || !receipt.Recovery || receipt.Timestamp-first.Timestamp != 90000/uint32(config.FPS) {
			t.Fatalf("refresh identity/timeline: %+v %+v %v", first, receipt, refreshErr)
		}
		first = receipt
		output.mu.Lock()
		packets := append([][]byte(nil), output.packets...)
		output.mu.Unlock()
		var prior rtp.Packet
		if err = prior.Unmarshal(packets[before-1]); err != nil {
			t.Fatal(err)
		}
		idr := false
		parser := &codecs.H264Packet{}
		for _, data := range packets[before:] {
			var packet rtp.Packet
			if err = packet.Unmarshal(data); err != nil {
				t.Fatal(err)
			}
			if packet.SSRC != prior.SSRC || packet.SequenceNumber != prior.SequenceNumber+1 {
				t.Fatalf("encoder restart broke RTP continuity: %+v -> %+v", prior.Header, packet.Header)
			}
			prior = packet
			nals, parseErr := parser.Unmarshal(packet.Payload)
			if parseErr != nil {
				t.Fatal(parseErr)
			}
			for _, nal := range bytes.Split(nals, []byte{0, 0, 0, 1}) {
				if len(nal) > 0 && nal[0]&31 == 5 {
					idr = true
				}
			}
		}
		if !idr {
			t.Fatal("PLI refresh did not emit an IDR")
		}
		if &video.pixels[0] != address {
			t.Fatal("recovery allocated another raw-frame cache")
		}
	}
	next, err := video.WriteFrame(ctx, 42, pixels)
	if err != nil || next.Recovery || next.Sequence != 42 {
		t.Fatalf("new source frame after recovery: %+v %v", next, err)
	}
	if &video.pixels[0] != address {
		t.Fatal("new source frame allocated another raw-frame cache")
	}
}

// Loss injection is before the encrypted transport, not a synthetic decoded result.
type dropFirstPicture struct {
	output  RTPWriter
	dropped bool
}

func (d *dropFirstPicture) RTP(data []byte) error {
	if !d.dropped {
		var packet rtp.Packet
		if err := packet.Unmarshal(data); err != nil {
			return err
		}
		d.dropped = packet.Marker
		return nil
	}
	return d.output.RTP(data)
}
