import type { ReactNode } from "react";
import InfoTip from "../components/InfoTip";
import { useSectionCollapse } from "./sectionCollapse";

// Header for a collapsible section. The chevron + title is a toggle button; the
// ⓘ sits outside it (nesting InfoTip's own <button> inside would be invalid
// HTML) and swallows its own click, so tapping it never collapses the section.
export function SectionCollapseHead({ title, info, extra, collapsed, onToggle }: {
  title: string;
  info?: string | Array<string | ReactNode>;
  extra?: ReactNode;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="bt-section-head">
      <button type="button" className="bt-section-toggle" onClick={onToggle} aria-expanded={!collapsed}>
        <span className={`bt-section-chevron${collapsed ? " collapsed" : ""}`} aria-hidden="true">
          ▾
        </span>
        <span className="instrument-section-title bt-section-title">
          <span>{title}</span>
        </span>
      </button>
      {info && <InfoTip text={info} />}
      {extra}
    </div>
  );
}

// A collapsible settings section.
export function Section({ title, info, extra, children }: { title: string; info?: string | Array<string | ReactNode>; extra?: ReactNode; children: ReactNode }) {
  const [collapsed, toggle] = useSectionCollapse(title);
  return (
    <div className={`bt-section${collapsed ? " collapsed" : ""}`}>
      <SectionCollapseHead title={title} info={info} extra={extra} collapsed={collapsed} onToggle={toggle} />
      {!collapsed && children}
    </div>
  );
}
