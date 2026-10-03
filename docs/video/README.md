# Stock Dashboard walkthrough

[Watch or download the two-minute demo](stock-dashboard-demo.mp4).

The video is caption-led, with no voiceover or music. It records the actual app
using the fictional sample portfolio, including a live OpenAI tool call. Captions
are burned into the picture so they remain visible when embedded on a website.

| Asset | Use |
|---|---|
| [MP4](stock-dashboard-demo.mp4) | 2:00, 1920×1080, 30 fps, H.264, about 4.6 MB; optimized for progressive web playback |
| [SRT](stock-dashboard-demo.srt) | Editable captions for video editors or a later upload |
| [WebVTT](stock-dashboard-demo.vtt) | Caption text for a website player; the MP4 already displays these captions |
| [Narration script](narration.md) | Transcript and timings; also usable for a future voiceover |

## What is shown

- 0:00–0:14: market dashboard and sample-data badge.
- 0:14–0:42: ledger-derived holdings, the position breach, risk-rule configuration, and transactions.
- 0:42–1:17: a live AI request, `checkPortfolioRisk`, and the resulting explanation.
- 1:17–1:34: long-term and day-trading simulator sleeves.
- 1:34–1:45: the separate Alpaca paper page with execution disabled.
- 1:45–2:00: ownership statement and public repository link.

Recorded on 3 October 2026 with OpenAI `gpt-4.1-mini`. The tool returned MSFT at
18.15% against a 15% position limit. This is a captured result, not a current
market claim. No trade was requested or executed. The paper account is deliberately
unconnected: no broker credentials were loaded, so its unavailable broker snapshot
and stale heartbeat are expected. The footage does not demonstrate a kill-switch
toggle; the caption refers to the backend checks linked in the main README.

The browser recording is 1440×720, scaled to 1920×960 above a 120-pixel caption
band. The app footage runs at its captured speed. A separate 15-second closing
card is added; the UI and tool results are not fabricated or replaced. The video
contains no real holdings, API keys, account numbers, or production settings.

## Website use

Copy the MP4 and a screenshot poster into your website's public assets and use
native video controls. For example, after placing them under `/portfolio/stock/`:

```html
<video controls playsinline preload="metadata"
       poster="/portfolio/stock/01-dashboard.png"
       aria-label="Two-minute Stock Dashboard demo with visible captions"
       style="width:100%;height:auto">
  <source src="/portfolio/stock/stock-dashboard-demo.mp4" type="video/mp4">
  <a href="/portfolio/stock/stock-dashboard-demo.mp4">Download the demo</a>
</video>
```

Provide the transcript as a link beside the player. An additional subtitle track
is optional; enabling it would duplicate the captions already visible in this MP4.
The video has not been uploaded to YouTube or another video host.
