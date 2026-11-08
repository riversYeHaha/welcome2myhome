import { useState } from 'react';
import type { HostDoll } from '@shared/host';
import type { E1Effect, LevelType } from '@shared/levels';
import { hostApi, P0_LEVEL_TYPES, P2_LEVEL_TYPES } from './api';

export interface DollEditorProps {
  doll: HostDoll;
  onSaved: (doll: HostDoll) => void;
  onClose: () => void;
}

const E1_EFFECTS: Array<{ value: E1Effect; label: string }> = [
  { value: 'starlight', label: '星光' },
  { value: 'confetti', label: '纸屑' },
  { value: 'bubbles', label: '泡泡' },
  { value: 'sparks', label: '火花' },
];

export function DollEditor({ doll, onSaved, onClose }: DollEditorProps): JSX.Element {
  const [name, setName] = useState(doll.name);
  const [tagline, setTagline] = useState(doll.tagline);
  const [clue, setClue] = useState(doll.clue);
  const [hideHint, setHideHint] = useState(doll.hide_hint);
  const [baseStory, setBaseStory] = useState(doll.base_story);
  const [baseCaption, setBaseCaption] = useState(doll.base_caption);

  const [levelType, setLevelType] = useState<LevelType>(
    doll.level_type === 'discovery' ? 'discovery' : 'bonus_quiz',
  );
  const [eggEnabled, setEggEnabled] = useState(doll.egg_enabled);
  const [e1Effect, setE1Effect] = useState<E1Effect>(doll.e1_effect);
  const [e1Sound, setE1Sound] = useState(doll.e1_sound);

  const [riddleType, setRiddleType] = useState<'single_choice' | 'short_answer'>(
    doll.riddle_type ?? 'single_choice',
  );
  const [question, setQuestion] = useState(doll.question);
  const [optionsText, setOptionsText] = useState(doll.options.join('\n'));
  const [answer, setAnswer] = useState('');
  const [hint, setHint] = useState(doll.hint);
  const [wrongText, setWrongText] = useState(doll.wrong_text);
  const [maxAttempts, setMaxAttempts] = useState(String(doll.max_attempts));
  const [synonymsText, setSynonymsText] = useState(doll.synonyms.join('\n'));

  const [secretStory, setSecretStory] = useState(doll.secret_story);
  const [secretWhisper, setSecretWhisper] = useState(doll.secret_whisper);
  const [secretStar, setSecretStar] = useState(doll.secret_star);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const effectiveEgg = levelType === 'bonus_quiz' && eggEnabled;

  async function save(): Promise<void> {
    if (!name.trim()) {
      setError('名字不能为空');
      return;
    }
    if (effectiveEgg && !answer.trim()) {
      setError('启用彩蛋题时需要重新填写正确答案（服务端不回显答案）');
      return;
    }

    setBusy(true);
    setError('');
    try {
      await hostApi.updateDoll(doll.doll_id, {
        name,
        tagline,
        clue,
        hideHint,
        baseStory,
        baseCaption,
      });

      const options = optionsText
        .split('\n')
        .map((option) => option.trim())
        .filter(Boolean);
      const synonyms = synonymsText
        .split(/[\n,，]/)
        .map((synonym) => synonym.trim())
        .filter(Boolean);

      const response = await hostApi.updateLevel(doll.doll_id, {
        level_type: levelType,
        egg_enabled: effectiveEgg,
        next_clue: null,
        e1: { effect: e1Effect, sound: e1Sound },
        ...(effectiveEgg
          ? {
              riddle: {
                type: riddleType,
                question,
                options,
                answer,
                hint,
                wrong_text: wrongText,
                max_attempts: Number(maxAttempts) || 0,
                synonyms,
              },
            }
          : {}),
        secret: {
          story: secretStory,
          whisper: secretWhisper,
          effect: 'golden_gather',
          star: secretStar,
        },
      });

      onSaved(response.doll);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel editor" aria-label={`编辑 ${doll.name}`}>
      <div className="panel-head">
        <h2>编辑人偶 · {doll.name}</h2>
        <button type="button" className="ghost" onClick={onClose}>
          收起
        </button>
      </div>

      <h3>基础</h3>
      <div className="field-grid">
        <label>
          名字
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={30} />
        </label>
        <label>
          一句话
          <input
            value={tagline}
            onChange={(event) => setTagline(event.target.value)}
            maxLength={80}
          />
        </label>
        <label>
          卡面线索（藏匿提示）
          <input value={clue} onChange={(event) => setClue(event.target.value)} maxLength={120} />
        </label>
        <label>
          藏匿位置备注（仅主人可见）
          <input
            value={hideHint}
            onChange={(event) => setHideHint(event.target.value)}
            maxLength={120}
          />
        </label>
      </div>

      <label>
        基础故事（扫码即给，≤200 字）
        <textarea
          value={baseStory}
          onChange={(event) => setBaseStory(event.target.value)}
          maxLength={200}
          rows={3}
        />
      </label>
      <label>
        基础谜底一句话
        <input
          value={baseCaption}
          onChange={(event) => setBaseCaption(event.target.value)}
          maxLength={120}
        />
      </label>

      <h3>关卡</h3>
      <div className="field-grid">
        <label>
          关卡类型
          <select
            value={levelType}
            onChange={(event) => setLevelType(event.target.value as LevelType)}
          >
            {P0_LEVEL_TYPES.map((type) => (
              <option key={type.value} value={type.value}>
                {type.label}
              </option>
            ))}
            {P2_LEVEL_TYPES.map((type) => (
              <option key={type.value} value={type.value} disabled>
                {type.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          E1 特效主题
          <select
            value={e1Effect}
            onChange={(event) => setE1Effect(event.target.value as E1Effect)}
          >
            {E1_EFFECTS.map((effect) => (
              <option key={effect.value} value={effect.value}>
                {effect.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="checkbox">
        <input
          type="checkbox"
          checked={levelType === 'bonus_quiz' && eggEnabled}
          disabled={levelType === 'discovery'}
          onChange={(event) => setEggEnabled(event.target.checked)}
        />
        启用彩蛋题（E2）
      </label>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={e1Sound}
          onChange={(event) => setE1Sound(event.target.checked)}
        />
        E1 播放音效
      </label>

      {effectiveEgg ? (
        <div className="sub-panel">
          <h3>彩蛋题</h3>
          <div className="field-grid">
            <label>
              题型
              <select
                value={riddleType}
                onChange={(event) =>
                  setRiddleType(event.target.value as 'single_choice' | 'short_answer')
                }
              >
                <option value="single_choice">单选</option>
                <option value="short_answer">简答</option>
              </select>
            </label>
            <label>
              尝试次数上限（0 = 不限）
              <input
                type="number"
                min={0}
                max={100}
                value={maxAttempts}
                onChange={(event) => setMaxAttempts(event.target.value)}
              />
            </label>
          </div>

          <label>
            题干
            <input
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              maxLength={200}
            />
          </label>

          {riddleType === 'single_choice' ? (
            <label>
              选项（每行一个，2–4 个）
              <textarea
                value={optionsText}
                onChange={(event) => setOptionsText(event.target.value)}
                rows={4}
              />
            </label>
          ) : null}

          <div className="field-grid">
            <label>
              正确答案（必填，不会回显）
              <input
                value={answer}
                onChange={(event) => setAnswer(event.target.value)}
                placeholder="重新填写正确答案"
                maxLength={100}
              />
            </label>
            <label>
              同义词（每行一个）
              <textarea
                value={synonymsText}
                onChange={(event) => setSynonymsText(event.target.value)}
                rows={2}
              />
            </label>
          </div>

          <label>
            提示
            <input value={hint} onChange={(event) => setHint(event.target.value)} maxLength={200} />
          </label>
          <label>
            答错文案
            <input
              value={wrongText}
              onChange={(event) => setWrongText(event.target.value)}
              maxLength={200}
            />
          </label>
        </div>
      ) : null}

      <h3>秘密彩蛋（E2）</h3>
      <label>
        隐藏故事
        <textarea
          value={secretStory}
          onChange={(event) => setSecretStory(event.target.value)}
          maxLength={1000}
          rows={2}
        />
      </label>
      <label>
        悄悄话
        <input
          value={secretWhisper}
          onChange={(event) => setSecretWhisper(event.target.value)}
          maxLength={200}
        />
      </label>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={secretStar}
          onChange={(event) => setSecretStar(event.target.checked)}
        />
        收藏册加星
      </label>

      {error ? <p className="err">{error}</p> : null}

      <div className="row">
        <button type="button" disabled={busy} onClick={() => void save()}>
          {busy ? '保存中…' : '保存'}
        </button>
        <button type="button" className="ghost" onClick={onClose}>
          取消
        </button>
      </div>
    </section>
  );
}
