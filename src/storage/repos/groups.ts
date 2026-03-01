import { withConnection } from "../connection";
import type { Group } from "../types";

export const groups = {
  create: (group: Group) =>
    withConnection((conn) =>
      conn
        .prepare(
          `INSERT INTO groups (id, channel, chat_id, name, folder, is_main) VALUES ($id, $channel, $chat_id, $name, $folder, $is_main)`,
        )
        .run({
          id: group.id,
          channel: group.channel,
          chat_id: group.chat_id,
          name: group.name,
          folder: group.folder,
          is_main: group.is_main,
        }),
    ),
  getById: (id: string): Group | null =>
    withConnection(
      (conn) => conn.prepare("SELECT * FROM groups WHERE id = ?").get(id) as Group | null,
    ),
  getByFolder: (folder: string): Group | null =>
    withConnection(
      (conn) => conn.prepare("SELECT * FROM groups WHERE folder = ?").get(folder) as Group | null,
    ),
  list: (): Group[] =>
    withConnection((conn) => conn.prepare("SELECT * FROM groups").all() as Group[]),
  update: (id: string, group: Partial<Omit<Group, "id">>) =>
    withConnection((conn) => {
      const keys = Object.keys(group);
      if (keys.length === 0) {
        return;
      }
      const sets = keys.map((k) => `${k} = $${k}`).join(", ");
      const params: Record<string, string | number | null> = { id: id };
      for (const [k, v] of Object.entries(group)) {
        params[k] = (v as string | number | null) ?? null;
      }
      conn.prepare(`UPDATE groups SET ${sets} WHERE id = $id`).run(params);
    }),
  delete: (id: string) =>
    withConnection((conn) => conn.prepare("DELETE FROM groups WHERE id = ?").run(id)),
};
