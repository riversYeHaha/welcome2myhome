/** Finale types shared by server and (later) the host UI. No runtime deps. */

export type FinaleTriggerType = 'all_collected' | 'count_gte' | 'all_eggs' | 'manual';

export interface FinaleTrigger {
  type: FinaleTriggerType;
  /** Only `count_gte` uses a number; the others store null. */
  value: number | null;
}

export interface FinaleConfig {
  enabled: boolean;
  trigger: FinaleTrigger;
  title: string;
  body: string;
  image_url: string | null;
  model_url: string | null;
  reward_note: string;
  share_caption: string;
  /** Set by the host's manual "open finale" action (ISO timestamp). */
  opened_at: string | null;
}

export const DEFAULT_FINALE: FinaleConfig = {
  enabled: true,
  trigger: { type: 'all_collected', value: null },
  title: '你今晚见到了我们全家',
  body: '',
  image_url: null,
  model_url: null,
  reward_note: '',
  share_caption: '',
  opened_at: null,
};

export const DEFAULT_FINALE_JSON = JSON.stringify(DEFAULT_FINALE);
