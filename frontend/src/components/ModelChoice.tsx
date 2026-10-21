/**
 * The composer's model control. There is one AI: CodeConClave AI. The router
 * picks the engine per task (CodeConClave's own tuned models first); users
 * never pick, and never see, another provider. Real token usage is still
 * logged per request on the server.
 */
import { useEffect } from 'react';
import { BrandLogo } from './BrandLogo';
import { AUTO_MODEL } from './ModelPicker';

interface ModelChoiceProps {
  value?: string;
  onChange: (id: string) => void;
  [key: string]: unknown;
}

export function ModelChoice({ value, onChange }: ModelChoiceProps) {
  // Always route automatically; drop any stale explicit choice.
  useEffect(() => {
    if (value && value !== AUTO_MODEL && value !== 'codeconclave-ai') onChange(AUTO_MODEL);
  }, [value, onChange]);

  return (
    <span
      className="cc-model-chip"
      title="CodeConClave AI picks the best engine for each task."
      aria-label="Model: CodeConClave AI (automatic)"
      data-testid="model-chip"
    >
      <BrandLogo variant="mark" height={16} className="cc-model-chip__mark" />
      CodeConClave AI
    </span>
  );
}
