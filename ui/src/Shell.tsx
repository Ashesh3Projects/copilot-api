import type { ReactNode } from "react"

import { AppShell } from "@astryxdesign/core/AppShell"
import { IconButton } from "@astryxdesign/core/IconButton"
import {
  SideNav,
  SideNavHeading,
  SideNavItem,
  SideNavSection,
} from "@astryxdesign/core/SideNav"

import {
  ArrowRightLeftIcon,
  BugIcon,
  ChartBarIcon,
  CopilotIcon,
  FallbackIcon,
  FlagIcon,
  GaugeIcon,
  LogOutIcon,
  MessageSquareIcon,
  MonitorIcon,
  MoonIcon,
  PlugIcon,
  Repeat2Icon,
  RouteIcon,
  SettingsIcon,
  SlidersHorizontalIcon,
  SunIcon,
} from "./icons"
import { post } from "./lib/api"
import { useHashRoute } from "./lib/router"
import { useThemeMode } from "./lib/theme-mode"

interface NavEntry {
  section: string
  label: string
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>
}

const MONITOR_ITEMS: Array<NavEntry> = [
  { section: "overview", label: "Overview", icon: GaugeIcon },
  { section: "sessions", label: "Sessions", icon: MessageSquareIcon },
  { section: "environments", label: "Environments", icon: MonitorIcon },
  { section: "llm-debug", label: "LLM Debug", icon: BugIcon },
  { section: "usage", label: "Usage", icon: ChartBarIcon },
]

const CONTROL_ITEMS: Array<NavEntry> = [
  { section: "accounts", label: "GitHub Accounts", icon: CopilotIcon },
  { section: "flags", label: "Feature Flags", icon: FlagIcon },
  { section: "replacements", label: "Replacements", icon: Repeat2Icon },
  {
    section: "model-redirects",
    label: "Model Redirects",
    icon: ArrowRightLeftIcon,
  },
  {
    section: "fallbacks",
    label: "Fallbacks",
    icon: FallbackIcon,
  },
  {
    section: "model-settings",
    label: "Model Settings",
    icon: SlidersHorizontalIcon,
  },
  { section: "custom-providers", label: "Custom Providers", icon: PlugIcon },
  { section: "model-routing", label: "Model Routing", icon: RouteIcon },
]

const SYSTEM_ITEMS: Array<NavEntry> = [
  { section: "settings", label: "Settings", icon: SettingsIcon },
]

function NavItems({
  items,
  currentSection,
}: {
  items: Array<NavEntry>
  currentSection: string
}) {
  return (
    <>
      {items.map((item) => (
        <SideNavItem
          key={item.section}
          label={item.label}
          icon={item.icon}
          href={`#${item.section}`}
          isSelected={currentSection === item.section}
        />
      ))}
    </>
  )
}

async function logout(): Promise<void> {
  try {
    await post("/dashboard/auth/logout")
  } finally {
    globalThis.location.reload()
  }
}

export function Shell({ children }: { children: ReactNode }) {
  const { section } = useHashRoute()
  const { mode, toggle } = useThemeMode()
  const favicon = document
    .querySelector<HTMLLinkElement>('link[rel="icon"]')
    ?.getAttribute("href")

  return (
    <AppShell
      height="fill"
      contentPadding={0}
      variant="elevated"
      sideNav={
        <SideNav
          collapsible
          header={
            <SideNavHeading
              heading="Copilot API"
              subheading="Admin Dashboard"
              icon={
                favicon ?
                  <img
                    src={favicon}
                    alt=""
                    width={32}
                    height={32}
                    style={{
                      display: "block",
                      flexShrink: 0,
                      boxSizing: "border-box",
                      padding: 4,
                      borderRadius: "var(--radius-element)",
                      background: "var(--color-background-muted)",
                      colorScheme: mode,
                    }}
                  />
                : undefined
              }
              headingHref="#overview"
            />
          }
          footerIcons={
            <>
              <IconButton
                label={
                  mode === "dark" ?
                    "Switch to light mode"
                  : "Switch to dark mode"
                }
                tooltip={mode === "dark" ? "Light mode" : "Dark mode"}
                variant="ghost"
                icon={mode === "dark" ? <SunIcon /> : <MoonIcon />}
                onClick={toggle}
              />
              <IconButton
                label="Sign out"
                tooltip="Sign out"
                variant="ghost"
                icon={<LogOutIcon />}
                onClick={() => void logout()}
              />
            </>
          }
        >
          <SideNavSection title="Monitor">
            <NavItems items={MONITOR_ITEMS} currentSection={section} />
          </SideNavSection>
          <SideNavSection title="Control">
            <NavItems items={CONTROL_ITEMS} currentSection={section} />
          </SideNavSection>
          <SideNavSection title="System">
            <NavItems items={SYSTEM_ITEMS} currentSection={section} />
          </SideNavSection>
        </SideNav>
      }
    >
      {children}
    </AppShell>
  )
}
