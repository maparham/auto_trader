// Opens the right editor for a server-evaluated alert: the bell, the alerts
// panel and the mobile list all hold only an id.
import { findServerAlert } from "./alertsApi";
import { indicatorAlertRequest, lineAlertRequest } from "./signals";

export function requestAlertEdit(id: string): void {
  if (findServerAlert(id)?.kind === "line") lineAlertRequest.set({ mode: "edit", id });
  else indicatorAlertRequest.set({ mode: "edit", id });
}
