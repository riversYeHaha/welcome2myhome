import { existsSync, readdirSync, rmSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from '../config';
import type { Db } from '../db';
import { listDolls } from '../db/repos/dolls';
import { getRoomById } from '../db/repos/rooms';
import { detectLanIp } from '../lib/network';
import { nowIso } from '../lib/ids';
import type { ClearSummary, SelfCheckItem, SelfCheckResult } from '../../shared/host';
import { parseFinaleConfig } from './finale';

export type { ClearSummary, SelfCheckItem, SelfCheckResult };

function dirBytes(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const name of readdirSync(dir)) {
    try {
      const stat = statSync(join(dir, name));
      if (stat.isFile()) total += stat.size;
    } catch {
      // Ignore files that disappear during the walk.
    }
  }
  return total;
}

/**
 * FR-13 one-click reset: wipe photos, models, silhouettes, guests, progress
 * and analytics for a room, keeping the room and doll configuration so the
 * host can re-run the same party. Returns what was removed for the UI.
 */
export function clearRoomData(db: Db, config: AppConfig, roomId: string): ClearSummary {
  const dolls = listDolls(db, roomId);
  const room = getRoomById(db, roomId);

  // Media files belonging to this room's dolls, plus exported print files.
  const targets: string[] = [];
  for (const dir of [config.paths.photos, config.paths.models, config.paths.silhouettes]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (dolls.some((doll) => name.startsWith(doll.doll_id))) targets.push(join(dir, name));
    }
  }
  if (existsSync(config.paths.exports)) {
    for (const name of readdirSync(config.paths.exports)) {
      if (name.startsWith(roomId)) targets.push(join(config.paths.exports, name));
    }
  }

  const counts = db.transaction(() => {
    const progress = db.prepare('DELETE FROM progress WHERE room_id = ?').run(roomId).changes;
    const guests = db.prepare('DELETE FROM guests WHERE room_id = ?').run(roomId).changes;
    const events = db.prepare('DELETE FROM events WHERE room_id = ?').run(roomId).changes;
    const genTasks = db.prepare('DELETE FROM gen_tasks WHERE room_id = ?').run(roomId).changes;
    const assets = db.prepare('DELETE FROM assets WHERE room_id = ?').run(roomId).changes;

    const now = nowIso();
    db.prepare(
      `UPDATE dolls SET
         source_photo = NULL,
         gen_status = 'preset',
         gen_task_id = NULL,
         base_model_url = '',
         base_photo_url = '',
         silhouette_url = '',
         secret_model_url = NULL,
         updated_at = ?
       WHERE room_id = ?`,
    ).run(now, roomId);

    if (room) {
      const finale = parseFinaleConfig(room.finale_json);
      const nextFinale = { ...finale, opened_at: null };
      db.prepare(
        `UPDATE rooms SET status = 'draft', finale_json = ?, updated_at = ? WHERE room_id = ?`,
      ).run(JSON.stringify(nextFinale), now, roomId);
    }

    return {
      progress,
      guests,
      events,
      gen_tasks: genTasks,
      assets,
    };
  })();

  let files = 0;
  let bytes = 0;
  for (const target of targets) {
    try {
      bytes += statSync(target).size;
      rmSync(target, { force: true });
      files += 1;
    } catch {
      // A stale path must not fail the reset.
    }
  }

  return { ...counts, files, bytes };
}

export interface ExportDoll {
  name: string;
  tagline: string;
  clue: string;
  hide_hint: string;
  level_type: string;
  egg_enabled: boolean;
  e1_effect: string;
  e1_sound: boolean;
  riddle: {
    type: string | null;
    question: string;
    options: string[];
    hint: string;
    wrong_text: string;
    max_attempts: number;
  };
  story: string;
  caption: string;
  secret_story: string;
  secret_whisper: string;
  secret_effect: string;
  secret_star: boolean;
  answer_configured: boolean;
}

function parseArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

/**
 * Portable configuration export (FR-13). Deliberately excludes the PIN hash,
 * answer hashes and card tokens: it is a readable record, not a credential dump.
 */
export function exportConfig(db: Db, roomId: string): Record<string, unknown> | null {
  const room = getRoomById(db, roomId);
  if (!room) return null;

  const dolls: ExportDoll[] = listDolls(db, roomId).map((doll) => ({
    name: doll.name,
    tagline: doll.tagline,
    clue: doll.clue,
    hide_hint: doll.hide_hint,
    level_type: doll.level_type,
    egg_enabled: doll.egg_enabled === 1,
    e1_effect: doll.e1_effect,
    e1_sound: doll.e1_sound === 1,
    riddle: {
      type: doll.riddle_type,
      question: doll.question,
      options: parseArray(doll.options_json),
      hint: doll.hint,
      wrong_text: doll.wrong_text,
      max_attempts: doll.max_attempts,
    },
    story: doll.base_story,
    caption: doll.base_caption,
    secret_story: doll.secret_story,
    secret_whisper: doll.secret_whisper,
    secret_effect: doll.secret_effect,
    secret_star: doll.secret_star === 1,
    answer_configured: doll.answer_hash.length > 0,
  }));

  return {
    schema: 'welcome2myhome/config',
    version: 1,
    exported_at: nowIso(),
    room: {
      room_code: room.room_code,
      title: room.title,
      game_mode: room.game_mode,
      default_level_type: room.default_level_type,
      lan_ip: room.lan_ip,
      port: room.port,
      finale: parseFinaleConfig(room.finale_json),
    },
    dolls,
  };
}

/** FR-01/FR-21 self check: LAN address, assets, configuration readiness. */
export function selfCheck(db: Db, config: AppConfig, roomId: string): SelfCheckResult | null {
  const room = getRoomById(db, roomId);
  if (!room) return null;

  const dolls = listDolls(db, roomId);
  const detected = detectLanIp();
  const lanIp = room.lan_ip || detected || '';
  const port = room.port || config.server.port;

  const guestCount = (
    db.prepare('SELECT COUNT(*) AS n FROM guests WHERE room_id = ?').get(roomId) as { n: number }
  ).n;
  const eventCount = (
    db.prepare('SELECT COUNT(*) AS n FROM events WHERE room_id = ?').get(roomId) as { n: number }
  ).n;

  const missing = dolls.filter((doll) => {
    if (doll.gen_status !== 'done') return false;
    if (!doll.base_model_url) return true;
    return !existsSync(join(config.paths.models, `${doll.doll_id}.glb`));
  }).length;

  const eggDolls = dolls.filter((doll) => doll.egg_enabled === 1);
  const eggReady = eggDolls.every((doll) => doll.answer_hash.length > 0);
  const finale = parseFinaleConfig(room.finale_json);

  let writable = true;
  try {
    const probe = join(config.paths.data, `.selfcheck-${process.pid}`);
    writeFileSync(probe, 'ok');
    unlinkSync(probe);
  } catch {
    writable = false;
  }

  const urls: Array<{ label: string; url: string }> = [];
  if (lanIp) {
    urls.push({ label: '客人扫码地址', url: `http://${lanIp}:${port}/` });
    urls.push({ label: '收藏册', url: `http://${lanIp}:${port}/collection` });
  }

  const checks: SelfCheckItem[] = [
    {
      id: 'lan_ip',
      label: '已设置局域网地址',
      ok: lanIp.length > 0,
      hint: lanIp ? undefined : '请在「局域网地址」里手动填入电脑的 Wi-Fi IP',
    },
    {
      id: 'lan_ip_match',
      label: '局域网地址与本机网卡一致',
      ok: !room.lan_ip || !detected || room.lan_ip === detected,
      hint:
        room.lan_ip && detected && room.lan_ip !== detected
          ? `当前网卡是 ${detected}，建议更新地址并重新导出卡片`
          : undefined,
    },
    {
      id: 'dolls',
      label: '至少有一位家庭成员',
      ok: dolls.length > 0,
      hint: dolls.length === 0 ? '先添加人偶，再导出卡片' : undefined,
    },
    {
      id: 'eggs',
      label: '彩蛋题的答案都配置好了',
      ok: eggReady,
      hint: eggReady ? undefined : '有人偶启用了彩蛋题但没填答案',
    },
    {
      id: 'models',
      label: '3D 模型文件齐全',
      ok: missing === 0,
      hint: missing > 0 ? `${missing} 个人偶标记已生成但模型文件缺失，可重新上传` : undefined,
    },
    {
      id: 'finale',
      label: '终局已配置',
      ok: finale.enabled,
      hint: finale.enabled ? undefined : '终局未启用，客人走完不会有结尾',
    },
    {
      id: 'disk',
      label: '数据目录可写',
      ok: writable,
      hint: writable ? undefined : '请检查 data/ 目录权限',
    },
    {
      id: 'local_only',
      label: '资产仅存本机',
      ok: true,
      hint: '照片与模型只保存在 ./data/，不会上传到第三方',
    },
  ];

  return {
    room: {
      room_id: room.room_id,
      room_code: room.room_code,
      title: room.title,
      status: room.status,
      lan_ip: lanIp,
      port,
    },
    server: {
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      uptime_sec: Math.round(process.uptime()),
      port: config.server.port,
      host: config.server.host,
    },
    network: {
      lan_ip: lanIp,
      detected_ip: detected,
      urls,
      hint:
        '手机打不开时：确认手机连的是同一个 Wi-Fi、关闭移动数据；路由器开启 AP 隔离 / 访客网络时同一局域网的设备也连不上。',
    },
    data: {
      db_bytes: existsSync(join(config.paths.data, 'home.db'))
        ? statSync(join(config.paths.data, 'home.db')).size
        : 0,
      photos_bytes: dirBytes(config.paths.photos),
      models_bytes: dirBytes(config.paths.models),
      dolls: dolls.length,
      guests: guestCount,
      events: eventCount,
      missing_assets: missing,
    },
    checks,
  };
}
