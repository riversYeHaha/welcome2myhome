import { useState } from 'react';
import type { FinaleConfig, FinaleTriggerType } from '@shared/finale';
import type { HostRoom } from '@shared/host';
import { hostApi } from './api';

export interface FinaleEditorProps {
  room: HostRoom;
  onSaved: () => Promise<void> | void;
}

const TRIGGERS: Array<{ value: FinaleTriggerType; label: string }> = [
  { value: 'all_collected', label: '集齐全部人偶（默认）' },
  { value: 'count_gte', label: '集齐 N 位' },
  { value: 'all_eggs', label: '集齐全部 + 解锁全部彩蛋' },
  { value: 'manual', label: '主人手动开启' },
];

export function FinaleEditor({ room, onSaved }: FinaleEditorProps): JSX.Element {
  const finale: FinaleConfig = room.finale;

  const [triggerType, setTriggerType] = useState<FinaleTriggerType>(finale.trigger.type);
  const [countValue, setCountValue] = useState(String(finale.trigger.value ?? 1));
  const [title, setTitle] = useState(finale.title);
  const [body, setBody] = useState(finale.body);
  const [rewardNote, setRewardNote] = useState(finale.reward_note);
  const [shareCaption, setShareCaption] = useState(finale.share_caption);
  const [imageUrl, setImageUrl] = useState(finale.image_url ?? '');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');

  async function save(): Promise<void> {
    setBusy(true);
    setError('');
    setWarning('');
    try {
      const response = await hostApi.updateFinale(room.room_id, {
        enabled: true,
        trigger: {
          type: triggerType,
          value: triggerType === 'count_gte' ? Math.max(1, Number(countValue) || 1) : null,
        },
        title,
        body,
        image_url: imageUrl.trim() || null,
        model_url: finale.model_url,
        reward_note: rewardNote,
        share_caption: shareCaption,
      });
      if (response.warning) setWarning(response.warning);
      await onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  async function openFinale(): Promise<void> {
    setBusy(true);
    setError('');
    try {
      await hostApi.openFinale(room.room_id);
      await onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '开启失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" aria-label="终局配置">
      <div className="panel-head">
        <h2>终局</h2>
        <span className="muted">
          {finale.opened_at ? `已手动开启 ${finale.opened_at.slice(0, 16).replace('T', ' ')}` : ''}
        </span>
      </div>

      <div className="field-grid">
        <label>
          触发条件
          <select
            value={triggerType}
            onChange={(event) => setTriggerType(event.target.value as FinaleTriggerType)}
          >
            {TRIGGERS.map((trigger) => (
              <option key={trigger.value} value={trigger.value}>
                {trigger.label}
              </option>
            ))}
          </select>
        </label>
        {triggerType === 'count_gte' ? (
          <label>
            集齐人数
            <input
              type="number"
              min={1}
              max={99}
              value={countValue}
              onChange={(event) => setCountValue(event.target.value)}
            />
          </label>
        ) : null}
      </div>

      <label>
        标题
        <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={80} />
      </label>
      <label>
        正文
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          maxLength={1000}
          rows={3}
        />
      </label>
      <label>
        图片 URL（可选）
        <input
          value={imageUrl}
          onChange={(event) => setImageUrl(event.target.value)}
          maxLength={300}
          placeholder="/assets/finale/finale_family.png"
        />
      </label>
      <label>
        实体奖励兑换语（可选）
        <input
          value={rewardNote}
          onChange={(event) => setRewardNote(event.target.value)}
          maxLength={200}
          placeholder="拿着这一页去找主人，换一张贴纸"
        />
      </label>
      <label>
        分享卡文案（可选）
        <input
          value={shareCaption}
          onChange={(event) => setShareCaption(event.target.value)}
          maxLength={200}
        />
      </label>

      {warning ? <p className="hint">{warning}</p> : null}
      {error ? <p className="err">{error}</p> : null}

      <div className="row">
        <button type="button" disabled={busy} onClick={() => void save()}>
          {busy ? '保存中…' : '保存终局'}
        </button>
        {triggerType === 'manual' ? (
          <button
            type="button"
            className="ghost"
            disabled={busy || Boolean(finale.opened_at)}
            onClick={() => void openFinale()}
          >
            {finale.opened_at ? '已开启' : '现在开启终局'}
          </button>
        ) : null}
      </div>
    </section>
  );
}
