// Labels for the "what is it doing" line, shown ONLY during a stall window with
// no moving progress bar (see the progress-feedback spec). Four keys only:
// candle download, the submit POST (local/remote), and the synchronous backtest
// run. Everything else is fast and stays unlabeled. Unknown/null -> "".
const LABELS: Record<string, string> = {
  downloading: "Downloading candles",
  submitting: "Submitting",
  uploading: "Uploading to compute host",
  engine: "Running backtest",
};

export function stageLabel(stage: string | null | undefined): string {
  if (!stage) return "";
  return LABELS[stage] ?? "";
}
