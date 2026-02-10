import { Lifecycle } from "../../runtime/host/lifecycle";

export async function showStatus() {
  const pid = Lifecycle.getPid();
  if (pid !== null) {
    console.log(`Mozi runtime is running (PID: ${pid}).`);
  } else {
    console.log("Mozi runtime is not running.");
  }
}
