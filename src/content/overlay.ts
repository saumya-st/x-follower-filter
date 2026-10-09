/** Small in-page status card (shadow DOM so X's CSS cannot touch it). */
export interface OverlayHandlers {
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}

export class Overlay {
  private host: HTMLElement | null = null;
  private text!: HTMLElement;
  private pauseBtn!: HTMLButtonElement;
  private stopBtn!: HTMLButtonElement;
  private paused = false;

  constructor(private handlers: OverlayHandlers) {}

  show(title: string): void {
    if (!this.host) this.mount();
    this.host!.style.display = "block";
    this.text.textContent = title;
  }

  status(text: string): void {
    if (this.host) this.text.textContent = text;
  }

  setPaused(p: boolean): void {
    this.paused = p;
    if (this.pauseBtn) this.pauseBtn.textContent = p ? "Resume" : "Pause";
  }

  setControls(enabled: boolean): void {
    if (!this.host) return;
    this.pauseBtn.style.display = enabled ? "" : "none";
    this.stopBtn.style.display = enabled ? "" : "none";
  }

  hide(delayMs = 0): void {
    if (!this.host) return;
    const h = this.host;
    setTimeout(() => (h.style.display = "none"), delayMs);
  }

  private mount(): void {
    const host = document.createElement("div");
    host.id = "xff-overlay-host";
    host.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;display:none;";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        .card{font:13px/1.4 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#0f1419;color:#e7e9ea;
          border:1px solid #2f3336;border-radius:12px;padding:12px 14px;min-width:260px;max-width:340px;box-shadow:0 8px 30px rgba(0,0,0,.45)}
        .row{display:flex;align-items:center;gap:8px;margin-top:8px}
        .brand{font-weight:700;font-size:12px;color:#8b98a5;letter-spacing:.3px;text-transform:uppercase}
        .txt{margin-top:4px;word-break:break-word}
        button{appearance:none;border:1px solid #536471;background:transparent;color:#e7e9ea;border-radius:999px;padding:4px 12px;font-weight:600;cursor:pointer}
        button:hover{background:#1d2a35}
        .stop{border-color:#f4212e;color:#f4212e}
        .stop:hover{background:rgba(244,33,46,.12)}
      </style>
      <div class="card">
        <div class="brand">X Follower Filter</div>
        <div class="txt" id="t"></div>
        <div class="row">
          <button id="p">Pause</button>
          <button id="s" class="stop">Stop</button>
        </div>
      </div>`;
    this.text = root.getElementById("t")!;
    this.pauseBtn = root.getElementById("p") as HTMLButtonElement;
    this.stopBtn = root.getElementById("s") as HTMLButtonElement;
    this.pauseBtn.addEventListener("click", () => {
      if (this.paused) this.handlers.onResume();
      else this.handlers.onPause();
      this.setPaused(!this.paused);
    });
    this.stopBtn.addEventListener("click", () => this.handlers.onStop());
    document.documentElement.appendChild(host);
    this.host = host;
  }
}
