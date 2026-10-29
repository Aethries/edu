"use client";

import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { AnimateUIProvider } from "@animate-ui/react/provider";
import { MotionConfig } from "motion/react";
import { getQueryClient } from "@/configs/query-client";

export function Providers({ children }: { children: ReactNode }) {
    const queryClient = getQueryClient();

    return (
        <QueryClientProvider client={queryClient}>
            <NuqsAdapter>
                <MotionConfig
                    reducedMotion="user"
                    transition={{ type: "tween", duration: 0.15 }}
                >
                    <AnimateUIProvider tempo={0.8}>
                        {children}
                    </AnimateUIProvider>
                </MotionConfig>
            </NuqsAdapter>
        </QueryClientProvider>
    );
}
