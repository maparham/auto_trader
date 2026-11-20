// The connection mark on a broker menu row: a green dot when the broker's latest
// call worked, a red "Not connected" badge when it failed (a dot alone was too
// easy to confuse with the green one), a gray ring when nothing has used it yet (it
// pulses while the server is still testing).
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
        <span className="broker-status-badge" role="img" aria-label={lines[0]}>
          Not connected
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
