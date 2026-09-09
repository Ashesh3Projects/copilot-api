import type { ComponentType, LazyExoticComponent } from "react"

import AccountsScreen from "./Accounts"
import CustomProvidersScreen from "./CustomProviders"
import EnvironmentsScreen from "./Environments"
import FallbacksScreen from "./Fallbacks"
import FlagsScreen from "./Flags"
import LlmDebugScreen from "./LlmDebug"
import LlmReplayScreen from "./LlmReplay"
import ModelRedirectsScreen from "./ModelRedirects"
import ModelRoutingScreen from "./ModelRouting"
import ModelSettingsScreen from "./ModelSettings"
import OverviewScreen from "./Overview"
import ReplacementsScreen from "./Replacements"
import SessionsScreen from "./Sessions"
import SettingsScreen from "./Settings"
import UsageScreen from "./Usage"

export interface ScreenEntry {
  kicker: string
  title: string
  component: ComponentType | LazyExoticComponent<ComponentType>
}

export const SCREENS: Record<string, ScreenEntry> = {
  accounts: {
    kicker: "Control",
    title: "GitHub accounts",
    component: AccountsScreen,
  },
  overview: {
    kicker: "Monitor",
    title: "Overview",
    component: OverviewScreen,
  },
  sessions: {
    kicker: "Monitor",
    title: "Sessions",
    component: SessionsScreen,
  },
  environments: {
    kicker: "Monitor",
    title: "Environments",
    component: EnvironmentsScreen,
  },
  "llm-debug": {
    kicker: "Monitor",
    title: "LLM Debug",
    component: LlmDebugScreen,
  },
  "llm-replay": {
    kicker: "Monitor",
    title: "LLM Replay",
    component: LlmReplayScreen,
  },
  usage: {
    kicker: "Monitor",
    title: "Usage",
    component: UsageScreen,
  },
  flags: {
    kicker: "Control",
    title: "Feature Flags",
    component: FlagsScreen,
  },
  replacements: {
    kicker: "Control",
    title: "Replacements",
    component: ReplacementsScreen,
  },
  "model-redirects": {
    kicker: "Control",
    title: "Model Redirects",
    component: ModelRedirectsScreen,
  },
  "model-settings": {
    kicker: "Control",
    title: "Model Settings",
    component: ModelSettingsScreen,
  },
  fallbacks: {
    kicker: "Control",
    title: "Fallbacks",
    component: FallbacksScreen,
  },
  "custom-providers": {
    kicker: "Control",
    title: "Custom Providers",
    component: CustomProvidersScreen,
  },
  "model-routing": {
    kicker: "Control",
    title: "Model Routing",
    component: ModelRoutingScreen,
  },
  settings: {
    kicker: "System",
    title: "Settings",
    component: SettingsScreen,
  },
}
