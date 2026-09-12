// Sign-up nudge shown in place of gated features while running the public
// demo (see lib/demoMode.ts). Two variants: the compact tab-bar button that
// stands in for the broker selector, and an inline variant for locked panel
// bodies (Task 9 uses this for the backtest Run button). Both just link to
// the sign-in ask; no modal, no state. Styling lives in App.css alongside
// the other tab-bar-actions rules (.demo-cta / .demo-cta-inline).

interface DemoCtaProps {
  // Locked-panel body variant: larger tap target, custom copy.
  inline?: boolean;
  label?: string;
}

export default function DemoCta({ inline = false, label }: DemoCtaProps) {
  const text = label ?? "Sign up free";
  return (
    <a
      className={inline ? "demo-cta-inline" : "tabbar-action demo-cta"}
      href="/?sign_in=1"
    >
      {text}
    </a>
  );
}
