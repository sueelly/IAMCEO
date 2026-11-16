// 답에 쓸 AI 고르기: 플랫폼 · 모델 · 추론 수준. Agent-A 가 지금 쓸 수 있다고 알린 것만 보인다. '기본값'이면 Agent-A 가 정한다.
// 댓글·답글·문서에 묻기의 입력칸 위에 둔다. 고른 값은 다음에 보내는 글 하나하나에 실린다.
import type { AgentAReviewAiCatalog, AgentAReviewAiSettings } from "@shared/agent-a";

export function AiPicker({ catalog, value, onChange, disabled }: {
  catalog: AgentAReviewAiCatalog | null;
  value: AgentAReviewAiSettings;
  onChange: (next: AgentAReviewAiSettings) => void;
  disabled?: boolean;
}) {
  if (!catalog?.available) return null;
  const provider = catalog.providers.find((p) => p.id === value.providerId) ?? null;
  // 모델은 고른 플랫폼의 것만. 플랫폼을 고르지 않았으면 기본 플랫폼의 모델을 보인다.
  const models = (provider ?? catalog.providers.find((p) => p.id === catalog.defaultProvider) ?? catalog.providers[0])?.models ?? [];
  const model = models.find((m) => m.id === value.model) ?? null;
  const efforts = (model ?? models.find((m) => m.default) ?? models[0])?.efforts ?? [];
  return (
    <div className="aar-ai" role="group" aria-label="답에 쓸 AI">
      <select aria-label="플랫폼" value={value.providerId ?? ""} disabled={disabled} onChange={(e) => onChange(e.target.value ? { providerId: e.target.value } : {})}>
        <option value="">플랫폼 기본값</option>
        {catalog.providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <select aria-label="모델" value={value.model ?? ""} disabled={disabled} onChange={(e) => onChange({ ...(value.providerId ? { providerId: value.providerId } : {}), ...(e.target.value ? { model: e.target.value } : {}) })}>
        <option value="">모델 기본값</option>
        {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
      </select>
      {efforts.length ? (
        <select aria-label="추론 수준" value={value.reasoningEffort ?? ""} disabled={disabled} onChange={(e) => {
          const { reasoningEffort: _r, ...rest } = value;
          onChange(e.target.value ? { ...rest, reasoningEffort: e.target.value } : rest);
        }}>
          <option value="">추론 기본값</option>
          {efforts.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
        </select>
      ) : null}
    </div>
  );
}
