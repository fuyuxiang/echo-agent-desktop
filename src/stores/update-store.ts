import { create } from "zustand";
import {
  checkAppUpdate,
  installAppUpdate,
  friendlyUpdateError,
  type AppUpdateInfo,
} from "@/lib/app-updater";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "installing"
  | "error";

interface UpdateStore {
  status: UpdateStatus;
  currentVersion?: string;
  update?: AppUpdateInfo;
  checkedAt?: string;
  downloaded: number;
  total?: number;
  error?: string;
  check: (manual?: boolean) => Promise<void>;
  install: () => Promise<void>;
  resetResult: () => void;
}

let checkInFlight: Promise<void> | null = null;
let installInFlight: Promise<void> | null = null;

export const useUpdateStore = create<UpdateStore>((set, get) => ({
  status: "idle",
  downloaded: 0,

  check: async (manual = false) => {
    if (checkInFlight) return checkInFlight;
    if (installInFlight) return installInFlight;

    checkInFlight = (async () => {
      set({ status: "checking", error: undefined, downloaded: 0, total: undefined });
      try {
        const result = await checkAppUpdate();
        set({
          status: result.update ? "available" : "up-to-date",
          currentVersion: result.currentVersion,
          checkedAt: result.checkedAt,
          update: result.update ?? undefined,
          error: undefined,
        });
      } catch (error) {
        const message = friendlyUpdateError(error);
        // A startup check must never interrupt an offline/VPN-less launch.
        // Keep the diagnostic for Help, but only turn it into a visible error
        // state when the user explicitly asked for a check.
        set({ status: manual ? "error" : "idle", error: message });
      } finally {
        checkInFlight = null;
      }
    })();
    return checkInFlight;
  },

  install: async () => {
    if (installInFlight) return installInFlight;
    const update = get().update;
    if (!update) {
      set({ status: "error", error: "没有可安装的更新，请重新检查" });
      return;
    }

    installInFlight = (async () => {
      set({ status: "downloading", downloaded: 0, total: undefined, error: undefined });
      try {
        await installAppUpdate(update.version, (progress) => {
          if (progress.event === "downloaded" || progress.event === "installed") {
            set({ status: "installing", downloaded: progress.downloaded });
            return;
          }
          set({
            status: "downloading",
            downloaded: progress.downloaded,
            total: progress.total ?? undefined,
          });
        });
      } catch (error) {
        set({ status: "error", error: friendlyUpdateError(error) });
      } finally {
        installInFlight = null;
      }
    })();
    return installInFlight;
  },

  resetResult: () => {
    const status = get().status;
    if (status === "downloading" || status === "installing") return;
    set({ status: "idle", error: undefined });
  },
}));
