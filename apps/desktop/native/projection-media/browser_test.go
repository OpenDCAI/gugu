//go:build browser

package projection

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

// This opt-in native integration test uses an isolated headless Chromium, not a
// user's browser or an installed Gugu instance. CI must provide the executable.
func TestChromiumDecodesEncodedProjection(t *testing.T) {
	chromium := os.Getenv("GUGU_TEST_CHROMIUM")
	if chromium == "" {
		t.Fatal("browser-tagged tests require GUGU_TEST_CHROMIUM")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	source, err := New(Config{Loopback: true})
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	offer, err := source.Offer(ctx)
	if err != nil {
		t.Fatal(err)
	}
	type decodedPixel struct {
		RGB       [3]int `json:"rgb"`
		Timestamp uint32 `json:"rtpTimestamp"`
	}
	pixels := make(chan decodedPixel, 64)
	failures := make(chan error, 1)
	failed := func(err error) {
		select {
		case failures <- err:
		default:
		}
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/offer", func(w http.ResponseWriter, _ *http.Request) { _ = json.NewEncoder(w).Encode(offer) })
	mux.HandleFunc("/answer", func(w http.ResponseWriter, r *http.Request) {
		var answer webrtc.SessionDescription
		if decodeErr := json.NewDecoder(http.MaxBytesReader(w, r.Body, 128*1024)).Decode(&answer); decodeErr != nil {
			failed(decodeErr)
			w.WriteHeader(400)
			return
		}
		if remoteErr := source.Remote(answer); remoteErr != nil {
			failed(remoteErr)
			w.WriteHeader(400)
		}
	})
	mux.HandleFunc("/pixel", func(w http.ResponseWriter, r *http.Request) {
		var pixel decodedPixel
		if decodeErr := json.NewDecoder(http.MaxBytesReader(w, r.Body, 100)).Decode(&pixel); decodeErr != nil {
			failed(decodeErr)
			return
		}
		select {
		case pixels <- pixel:
		default:
			failed(fmt.Errorf("browser pixel result queue full"))
		}
	})
	mux.HandleFunc("/error", func(w http.ResponseWriter, r *http.Request) {
		var message string
		_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&message)
		failed(fmt.Errorf("browser: %s", message))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte(projectionBrowserFixture))
	})
	server := httptest.NewServer(mux)
	defer server.Close()
	cmd := exec.CommandContext(ctx, chromium, "--headless=new", "--autoplay-policy=no-user-gesture-required", "--user-data-dir="+t.TempDir(), server.URL)
	diagnostics := &encoderLog{}
	cmd.Stderr = diagnostics
	cmd.Stdout = diagnostics
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	browserClosed := make(chan struct{})
	go func() {
		if waitErr := cmd.Wait(); ctx.Err() == nil {
			failed(fmt.Errorf("headless Chromium exited: %v: %s", waitErr, diagnostics.text()))
		}
		close(browserClosed)
	}()
	defer func() { cancel(); <-browserClosed }()
	if err = source.Ready(ctx); err != nil {
		t.Fatalf("browser media readiness: %v: %s", err, diagnostics.text())
	}
	config := testEncoderConfig(t)
	encoder, err := StartVideoEncoder(ctx, config, source)
	if err != nil {
		t.Fatal(err)
	}
	defer encoder.Close()
	var sequence uint64
	for channel := 0; channel < 3; channel++ {
		frame := make([]byte, config.Width*config.Height*4)
		for offset := 0; offset < len(frame); offset += 4 {
			frame[offset+channel] = 230
			frame[offset+3] = 255
		}
		ticker := time.NewTicker(100 * time.Millisecond)
		seen := false
		encoded := make(map[uint32]EncodedFrame)
		for !seen {
			select {
			case <-ticker.C:
				sequence++
				receipt, frameErr := encoder.WriteFrame(ctx, sequence, frame)
				if frameErr != nil {
					ticker.Stop()
					t.Fatalf("encoder: %v; Chromium: %s", frameErr, diagnostics.text())
				}
				encoded[receipt.Timestamp] = receipt
			case pixel := <-pixels:
				// Canvas reports RGB while the source buffer is BGRA.
				if receipt, matched := encoded[pixel.Timestamp]; matched && receipt.Sequence != 0 &&
					pixel.RGB[2-channel] >= 215 && pixel.RGB[(3-channel)%3] <= 15 && pixel.RGB[(4-channel)%3] <= 15 {
					seen = true
				}
			case browserErr := <-failures:
				ticker.Stop()
				t.Fatal(browserErr)
			case <-ctx.Done():
				ticker.Stop()
				t.Fatalf("browser did not decode color %d: %s", channel, diagnostics.text())
			}
		}
		ticker.Stop()
	}
}

const projectionBrowserFixture = `<!doctype html><video autoplay muted playsinline></video><canvas width="128" height="96"></canvas>
<script>
(async () => {
  const report = error => fetch('/error', {method:'POST', body:JSON.stringify(String(error))});
  window.addEventListener('unhandledrejection', event => report(event.reason));
  const video = document.querySelector('video'), canvas = document.querySelector('canvas');
  const draw = canvas.getContext('2d', {willReadFrequently: true});
  const peer = new RTCPeerConnection({iceServers: []});
  window.peer = peer;
  peer.ondatachannel = ({channel}) => { window.control = channel; channel.onmessage = () => {}; };
  peer.ontrack = ({track}) => { (async () => {
    video.srcObject = new MediaStream([track]);
    await video.play();
    const frame = (_, metadata) => {
      if (!Number.isInteger(metadata.rtpTimestamp)) { report('Decoded video frame has no RTP timestamp'); return; }
      draw.drawImage(video, 0, 0, 128, 96);
      fetch('/pixel', {method:'POST', body:JSON.stringify({rgb:Array.from(draw.getImageData(64,48,1,1).data).slice(0,3), rtpTimestamp:metadata.rtpTimestamp})});
      video.requestVideoFrameCallback(frame);
    };
    video.requestVideoFrameCallback(frame);
  })().catch(report); };
  await peer.setRemoteDescription(await (await fetch('/offer')).json());
  await peer.setLocalDescription(await peer.createAnswer());
  if (peer.iceGatheringState !== 'complete') await new Promise(resolve => peer.addEventListener('icegatheringstatechange', () => { if(peer.iceGatheringState === 'complete') resolve(); }));
  await fetch('/answer', {method:'POST', body:JSON.stringify(peer.localDescription)});
})().catch(error => fetch('/error', {method:'POST', body:JSON.stringify(String(error))}));
</script>`
