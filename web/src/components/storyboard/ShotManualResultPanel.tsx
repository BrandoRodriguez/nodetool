/**
 * ShotManualResultPanel — a shot waiting for a result the user makes by hand.
 *
 * A provider in assisted mode (a site whose terms forbid automated use)
 * sends nothing; it prepares the prompt and leaves the render to the user.
 * The panel shows that prompt with a copy action, brings the provider's
 * authorized tab forward, takes the image back by file picker or drop, and
 * lets the user drop the request. The request lives on the shot, so the panel
 * comes back after a reload.
 */
import React, { memo, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ManualResultRequest } from "@nodetool-ai/protocol";
import {
  Box,
  Caption,
  CopyButton,
  DropZone,
  EditorButton,
  FlexColumn,
  FlexRow,
  Text,
  UploadButton,
  BORDER_RADIUS,
  SPACING
} from "../ui_primitives";
import { trpcClient } from "../../trpc/client";
import { useStoryboardStore } from "../../stores/storyboard/StoryboardStore";
import { useImportShotStill } from "../../hooks/storyboard/useImportShotStill";

export interface ShotManualResultPanelProps {
  boardId: string;
  shotId: string;
  request: ManualResultRequest;
  readOnly?: boolean;
}

/** Bring the provider's tab forward; open its site when no tab can be shown. */
export const openProviderForManualStep = async (
  request: ManualResultRequest
): Promise<void> => {
  try {
    const { shown, openUrl } = await trpcClient.extension.showProviderTab.mutate({
      provider: request.provider
    });
    if (!shown) {
      window.open(openUrl, "_blank", "noopener,noreferrer");
    }
  } catch {
    if (request.open_url?.startsWith("https://")) {
      window.open(request.open_url, "_blank", "noopener,noreferrer");
    }
  }
};

const ShotManualResultPanelInner = ({
  boardId,
  shotId,
  request,
  readOnly
}: ShotManualResultPanelProps) => {
  const { t } = useTranslation();
  const importStill = useImportShotStill(boardId, shotId);
  const cancel = useStoryboardStore((state) => state.cancelShotManualResult);
  const [opening, setOpening] = useState(false);

  const handleOpen = useCallback(() => {
    setOpening(true);
    void openProviderForManualStep(request).finally(() => setOpening(false));
  }, [request]);
  const handleCancel = useCallback(
    () => cancel(boardId, shotId),
    [cancel, boardId, shotId]
  );

  return (
    <DropZone
      data-testid="shot-manual-result"
      onFilesDrop={readOnly ? undefined : importStill}
      overlay
      overlayLabel={t("screens4_19.storyboard.manualResult.dropHere")}
      sx={{ m: SPACING.lg, p: SPACING.md, borderRadius: BORDER_RADIUS.md, minWidth: 0 }}
    >
      <FlexColumn gap={SPACING.sm}>
        <Text size="small" weight={600}>
          {t("screens4_19.storyboard.manualResult.title", { provider: request.provider })}
        </Text>
        <Caption>{t("screens4_19.storyboard.manualResult.explain")}</Caption>
        <FlexRow gap={SPACING.xs} align="flex-start">
          <Box
            data-testid="shot-manual-prompt"
            sx={{
              flex: 1,
              minWidth: 0,
              maxHeight: "9em",
              overflow: "auto",
              whiteSpace: "pre-wrap",
              fontFamily: "monospace",
              fontSize: "0.8em"
            }}
          >
            {request.prompt}
          </Box>
          <CopyButton
            value={request.prompt}
            tooltip={t("screens4_19.storyboard.manualResult.copyPrompt")}
          />
        </FlexRow>
        {!readOnly && (
          <FlexRow gap={SPACING.xs} align="center" wrap>
            <EditorButton variant="outlined" onClick={handleOpen} disabled={opening}>
              {t("screens4_19.storyboard.manualResult.openProvider", {
                provider: request.provider
              })}
            </EditorButton>
            <UploadButton
              onFileSelect={importStill}
              accept="image/*"
              label={t("screens4_19.storyboard.manualResult.importStill")}
              tooltip={t("screens4_19.storyboard.manualResult.importStill")}
            />
            <EditorButton variant="text" onClick={handleCancel}>
              {t("screens4_19.storyboard.manualResult.cancel")}
            </EditorButton>
          </FlexRow>
        )}
      </FlexColumn>
    </DropZone>
  );
};

const ShotManualResultPanel = memo(ShotManualResultPanelInner);
export default ShotManualResultPanel;
