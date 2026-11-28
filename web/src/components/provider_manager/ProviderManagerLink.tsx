/** A compact pointer from Settings → Models & providers to the Provider Manager page. */
import React, { memo } from "react";
import { useTranslation } from "react-i18next";
import { Card, Caption, EditorButton, FlexColumn, FlexRow, Text, SPACING } from "../ui_primitives";
import { openPageTab } from "../workspace/openPageTab";

const ProviderManagerLink: React.FC = () => {
  const { t } = useTranslation();
  return (
    <Card variant="outlined" padding="compact" sx={{ mb: SPACING.lg }}>
      <FlexRow gap={SPACING.md} align="center" justify="space-between" wrap>
        <FlexColumn gap={SPACING.micro} sx={{ minWidth: 0, flex: "1 1 240px" }}>
          <Text size="small" weight={600}>
            {t("providerManager.link.title")}
          </Text>
          <Caption size="smaller" color="secondary">
            {t("providerManager.link.body")}
          </Caption>
        </FlexColumn>
        <EditorButton variant="outlined" onClick={() => openPageTab("providers")}>
          {t("providerManager.link.open")}
        </EditorButton>
      </FlexRow>
    </Card>
  );
};

export default memo(ProviderManagerLink);
