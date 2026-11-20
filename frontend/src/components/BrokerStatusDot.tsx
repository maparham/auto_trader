// The connection mark on a broker menu row: a green dot when the broker's
// latest call worked, a red circled X when it failed (a different shape, since
// a red dot beside the green ones was too easy to miss), a gray ring when
// nothing has used it yet (it pulses while the server is still testing).
import Tooltip from "./Tooltip";
import { brokerStatusText, type BrokerStatus } from "../lib/brokerStatus";

interface Props {
  status: BrokerStatus | undefined;
  checking: boolean;
}

export default function BrokerStatusDot({ status, checking }: Props) {
  const state = status?.state ?? "unknown";
  const lines = brokerStatusText(status, checking);
  const pulse = checking && state === "unknown" ? " is-checking" : "";
  if (state === "down") {
    return (
      <Tooltip content={lines} placement="left" asChild>
        <span className="broker-status-x" role="img" aria-label={lines[0]}>
          <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
            <circle cx="6" cy="6" r="6" fill="currentColor" />
            <path d="M4 4l4 4M8 4l-4 4" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </span>
      </Tooltip>
    );
  }
  return (
    <Tooltip content={lines} placement="left" asChild>
      <span
        className={`broker-status-dot is-${state}${pulse}`}
        role="img"
        aria-label={lines[0]}
      />
    </Tooltip>
  );
}
