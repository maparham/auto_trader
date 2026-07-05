// One row in the indicator menu: the indicator name (click adds an instance),
// a leading favourite star, and a trailing ⓘ that reveals a description tooltip
// via the shared InfoTip component.

import { indicatorInfo } from "./lib/indicatorMeta";
import Tooltip from "./components/Tooltip";
import InfoTip from "./components/InfoTip";

interface Props {
  name: string;
  favorite: boolean;
  onAdd: () => void;
  onToggleFavorite: () => void;
}

export default function IndicatorRow({ name, favorite, onAdd, onToggleFavorite }: Props) {
  const { title, desc } = indicatorInfo(name);

  return (
    <li className="ind-row" onClick={onAdd}>
      <Tooltip content={favorite ? "Remove from favorites" : "Add to favorites"}>
        <button
          className={"ind-star" + (favorite ? " on" : "")}
          aria-label={favorite ? "Remove from favorites" : "Add to favorites"}
          aria-pressed={favorite}
          onClick={(e) => {
            e.stopPropagation(); // don't add an instance
            onToggleFavorite();
          }}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
            <path d="M12 17.3l-5.4 3.3 1.5-6.2L3 10.2l6.3-.5L12 4l2.7 5.7 6.3.5-5.1 4.2 1.5 6.2z" />
          </svg>
        </button>
      </Tooltip>

      {/* Full name with the abbreviation in parens, e.g. "Relative Strength
          Index (RSI)". Uncatalogued indicators fall back to just the code. */}
      <span className="ind-name">
        {title === name ? name : `${title} (${name})`}
      </span>

      {desc && <InfoTip title={title} text={desc} />}
    </li>
  );
}
