/** Page styles, scoped to the `.sg-` prefix and built from DSH design tokens. */
export const CSS = `
.sg-page { box-sizing: border-box; height: 100%; overflow: auto; scrollbar-gutter: stable; padding: 28px clamp(20px, 4vw, 48px) 48px; color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 20px; }
.sg-column { max-width: 960px; margin: 0 auto; }
.sg-card { border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 16px; background: var(--dsw-alias-bg-layer-1, transparent); padding: 20px 24px; }
.sg-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.sg-title { margin: 0; font-size: 20px; line-height: 28px; font-weight: 600; }
.sg-intro { margin: 8px 0 0; max-width: 700px; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
.sg-master { display: flex; align-items: center; gap: 8px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.sg-switch { position: relative; flex: none; width: 42px; height: 24px; padding: 0; border: 0; border-radius: 999px; background: var(--dsw-alias-bg-layer-3); cursor: pointer; transition: background .15s ease; }
.sg-switch.on { background: var(--dsw-alias-button-primary-fill); }
.sg-switch:disabled { opacity: .5; cursor: default; }
.sg-knob { position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: var(--dsw-alias-label-primary-foreground, #fff); box-shadow: 0 1px 2px rgba(0, 0, 0, .18); transition: transform .15s ease; }
.sg-switch.on .sg-knob { transform: translateX(18px); }
.sg-flow { margin-top: 16px; padding: 10px 14px; border-radius: 10px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.sg-section { margin-top: 20px; padding-top: 20px; border-top: 0.5px solid var(--dsw-alias-border-l2); display: flex; flex-direction: column; gap: 10px; }
.sg-section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.sg-section-title { margin: 0; font-size: 14px; line-height: 22px; font-weight: 600; }
.sg-hint { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.sg-preview { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; padding: 10px 12px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 10px; background: var(--dsw-alias-bg-layer-1, transparent); color: var(--dsw-alias-label-secondary); max-height: 160px; overflow: auto; }
.sg-input, .sg-textarea { box-sizing: border-box; width: 100%; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 10px; padding: 8px 12px; font: inherit; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1, transparent); }
.sg-input:focus, .sg-textarea:focus { outline: none; border-color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 20%, transparent); }
.sg-textarea { resize: vertical; min-height: 120px; }
.sg-input.sg-invalid { border-color: var(--dsw-alias-state-error-primary); }
.sg-error-text { color: var(--dsw-alias-state-error-primary); }
.sg-input.sg-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.sg-list { display: flex; flex-direction: column; }
.sg-row { padding: 12px 0; border-top: 0.5px solid var(--dsw-alias-border-l2); display: flex; gap: 12px; align-items: flex-start; }
.sg-row:first-child { border-top: 0; padding-top: 0; }
.sg-dot { flex: none; width: 7px; height: 7px; margin-top: 7px; border-radius: 50%; background: var(--dsw-alias-state-success-primary); }
.sg-dot.off { background: var(--dsw-alias-state-idle-primary); }
.sg-row-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.sg-row-title { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; font-size: 14px; line-height: 20px; font-weight: 500; }
.sg-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sg-cron { color: var(--dsw-alias-label-tertiary); font-size: 12px; font-weight: 400; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.sg-row-preview { color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sg-row-meta { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-caption); }
.sg-row-actions { flex: none; display: flex; gap: 2px; align-items: center; }
.sg-btn { border: 0; background: transparent; padding: 4px 8px; border-radius: 8px; font: inherit; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); cursor: pointer; white-space: nowrap; }
.sg-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.sg-btn.primary { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
.sg-btn.primary:hover { background: var(--dsw-alias-button-primary-hover); }
.sg-btn.danger { color: var(--dsw-alias-state-error-primary); }
.sg-btn:disabled { opacity: .5; cursor: default; }
.sg-edit { padding: 14px; margin: 2px 0 6px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 12px; background: var(--dsw-alias-bg-layer-1, transparent); display: flex; flex-direction: column; gap: 12px; }
.sg-field { display: flex; flex-direction: column; gap: 6px; }
.sg-label { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.sg-field-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
.sg-actions { display: flex; align-items: center; gap: 8px; justify-content: flex-end; }
.sg-actions .sg-spacer { flex: 1; }
.sg-banner { margin-top: 14px; padding: 8px 12px; border-radius: 10px; background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent); font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
.sg-banner.error { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); color: var(--dsw-alias-state-error-primary); }
.sg-banner.success { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent); color: var(--dsw-alias-state-success-primary); }
.sg-advanced { margin-top: 20px; padding-top: 16px; border-top: 0.5px solid var(--dsw-alias-border-l2); }
.sg-advanced > summary { cursor: pointer; font-size: 13px; line-height: 20px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.sg-advanced-body { margin-top: 10px; display: flex; flex-direction: column; gap: 8px; }
.sg-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; overflow-wrap: anywhere; }
.sg-foot { margin-top: 20px; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.sg-empty { padding: 18px 0 8px; color: var(--dsw-alias-label-tertiary); }
.sg-close { margin-left: auto; }
@media (max-width: 720px) {
  .sg-page { padding: 20px 16px 32px; }
  .sg-card { padding: 16px; }
  .sg-field-row { grid-template-columns: 1fr; }
  .sg-row { flex-wrap: wrap; }
  .sg-row-actions { width: 100%; justify-content: flex-end; }
}
`
