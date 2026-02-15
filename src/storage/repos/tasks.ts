import type { Task } from "../types";
import { withConnection } from "../connection";

export const tasks = {
  create: (task: Task) =>
    withConnection((conn) =>
      conn
        .prepare(
          `INSERT INTO tasks (id, group_id, prompt, schedule_type, schedule_value, status, last_run, next_run) VALUES ($id, $group_id, $prompt, $schedule_type, $schedule_value, $status, $last_run, $next_run)`,
        )
        .run({
          id: task.id,
          group_id: task.group_id,
          prompt: task.prompt,
          schedule_type: task.schedule_type,
          schedule_value: task.schedule_value,
          status: task.status,
          last_run: task.last_run,
          next_run: task.next_run,
        }),
    ),
  getById: (id: string): Task | null =>
    withConnection(
      (conn) =>
        (conn.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Task | undefined) ?? null,
    ),
  listByGroup: (groupId: string): Task[] =>
    withConnection(
      (conn) => conn.prepare("SELECT * FROM tasks WHERE group_id = ?").all(groupId) as Task[],
    ),
  update: (id: string, task: Partial<Omit<Task, "id">>) =>
    withConnection((conn) => {
      const keys = Object.keys(task);
      if (keys.length === 0) {
        return;
      }
      const sets = keys.map((k) => `${k} = $${k}`).join(", ");
      const params: Record<string, string | number | null> = { id: id };
      for (const [k, v] of Object.entries(task)) {
        params[k] = (v as string | number | null) ?? null;
      }
      conn.prepare(`UPDATE tasks SET ${sets} WHERE id = $id`).run(params);
    }),
  delete: (id: string) =>
    withConnection((conn) => conn.prepare("DELETE FROM tasks WHERE id = ?").run(id)),
};
