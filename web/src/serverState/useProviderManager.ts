import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { trpcClient, type RouterInputs, type RouterOutputs } from "../trpc/client";

export const providerManagerQueryKeys = {
  all: ["providerManager"] as const,
  overview: () => [...providerManagerQueryKeys.all, "overview"] as const,
  status: () => [...providerManagerQueryKeys.all, "status"] as const
};

export type ProviderManagerOverview = RouterOutputs["providerManager"]["overview"];
export type ProviderManagerStatus = RouterOutputs["providerManager"]["status"];
export type ManagedProviderRow = ProviderManagerOverview["providers"][number];

/** Providers, transport choice and policy. Changes only when something is saved. */
export const useProviderManagerOverview = () =>
  useQuery({
    queryKey: providerManagerQueryKeys.overview(),
    queryFn: () => trpcClient.providerManager.overview.query(),
    staleTime: 30_000
  });

/**
 * Live connection status. Polls while the page is open, slowly: each check
 * asks the extension host and Orca, and nothing in it touches a provider.
 */
export const useProviderManagerStatus = () =>
  useQuery({
    queryKey: providerManagerQueryKeys.status(),
    queryFn: () => trpcClient.providerManager.status.query(),
    refetchInterval: 10_000,
    refetchOnWindowFocus: true,
    staleTime: 5_000
  });

const useInvalidatingMutation = <TInput, TOutput>(run: (input: TInput) => Promise<TOutput>) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSettled: () => queryClient.invalidateQueries({ queryKey: providerManagerQueryKeys.all })
  });
};

export const useSetBrowserTransport = () =>
  useInvalidatingMutation((input: RouterInputs["providerManager"]["setTransport"]) =>
    trpcClient.providerManager.setTransport.mutate(input)
  );

export const useOpenProviderSignInTab = () =>
  useInvalidatingMutation((input: RouterInputs["providerManager"]["openSignInTab"]) =>
    trpcClient.providerManager.openSignInTab.mutate(input)
  );

export const useAuthorizeProviderTab = () =>
  useInvalidatingMutation((input: RouterInputs["providerManager"]["authorizeTab"]) =>
    trpcClient.providerManager.authorizeTab.mutate(input)
  );

export const useRevokeProviderTab = () =>
  useInvalidatingMutation((input: RouterInputs["providerManager"]["revokeTab"]) =>
    trpcClient.providerManager.revokeTab.mutate(input)
  );

export const useSetPaidMedia = () =>
  useInvalidatingMutation((input: RouterInputs["providerManager"]["setPaidMedia"]) =>
    trpcClient.providerManager.setPaidMedia.mutate(input)
  );
