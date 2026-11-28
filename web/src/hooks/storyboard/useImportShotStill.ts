/**
 * Bring an image file in as a shot's still: upload it as an asset, then let
 * the board's import rule place it (`importShotStill`). Shared by "Upload your
 * own still" and the assisted-mode panel, so both behave the same way.
 */
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useAssetUpload } from "../../serverState/useAssetUpload";
import { useNotificationStore } from "../../stores/NotificationStore";
import { useStoryboardStore } from "../../stores/storyboard/StoryboardStore";
import { mediaRefFromAsset } from "../../utils/mediaRef";

/** True for a file a shot can take as its still. */
export const isStillFile = (file: File): boolean => file.type.startsWith("image/");

export const useImportShotStill = (
  boardId: string,
  shotId: string
): ((files: File[]) => void) => {
  const { t } = useTranslation();
  const uploadAsset = useAssetUpload((state) => state.uploadAsset);
  const importShotStill = useStoryboardStore((state) => state.importShotStill);
  return useCallback(
    (files: File[]) => {
      const file = files.find(isStillFile);
      if (!file) {
        if (files.length > 0) {
          useNotificationStore.getState().addNotification({
            type: "error",
            alert: true,
            dismissable: true,
            content: t("screens4_19.storyboard.manualResult.notAnImage")
          });
        }
        return;
      }
      uploadAsset({
        file,
        onCompleted: (asset) => {
          importShotStill(boardId, shotId, mediaRefFromAsset(asset, "image"));
        },
        onFailed: (error) =>
          useNotificationStore.getState().addNotification({
            type: "error",
            alert: true,
            dismissable: true,
            content: t("screens4_15.storyboard.shotCard.uploadFailed", { error })
          })
      });
    },
    [uploadAsset, importShotStill, boardId, shotId, t]
  );
};
