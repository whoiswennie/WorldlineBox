// @vitest-environment happy-dom
import { act, useEffect, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createPortal } from "react-dom";
import { afterEach, expect, it, vi } from "vitest";

import { ApplicationShell } from "../../src/renderer/ApplicationShell";
import { LocaleProvider } from "../../src/renderer/i18n";

let root: Root | undefined;
let container: HTMLDivElement | undefined;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(async () => {
  await act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

async function mount(content: ReactNode) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(() => root!.render(<LocaleProvider>{content}</LocaleProvider>));
}

it("keeps module state while suspending inactive module effects", async () => {
  const started = vi.fn();
  const stopped = vi.fn();
  function Assets() {
    const [count, setCount] = useState(0);
    useEffect(() => {
      started();
      return () => { stopped(); };
    }, []);
    return <button data-counter onClick={() => setCount(count + 1)}>{count}</button>;
  }
  function Fixture() {
    const [activeModuleId, setActiveModuleId] = useState("assets");
    return <ApplicationShell
      activeModuleId={activeModuleId}
      modules={[
        { id: "assets", label: "Assets", icon: "grid", content: <Assets /> },
        { id: "launcher", label: "Launcher", icon: "box", content: <p>Launcher content</p> },
      ]}
      onOpenSettings={() => undefined}
      onSelectModule={setActiveModuleId}
    />;
  }
  await mount(<Fixture />);
  await act(() => container!.querySelector<HTMLButtonElement>("[data-counter]")!.click());
  expect(container!.querySelector("[data-counter]")!.textContent).toBe("1");
  await act(() => container!.querySelector<HTMLButtonElement>('[data-application-module="launcher"]')!.click());
  expect(stopped).toHaveBeenCalledTimes(1);
  expect(container!.querySelector('[data-application-module="launcher"]')!.getAttribute("aria-current")).toBe("page");
  await act(() => container!.querySelector<HTMLButtonElement>('[data-application-module="assets"]')!.click());
  expect(container!.querySelector("[data-counter]")!.textContent).toBe("1");
  expect(started).toHaveBeenCalledTimes(2);
});

it("opens settings from the rail and shortcut, and respects disabled state", async () => {
  const openSettings = vi.fn();
  const renderShell = (settingsDisabled: boolean) => <ApplicationShell
    activeModuleId="assets"
    modules={[{ id: "assets", label: "Assets", icon: "grid", content: <p>Asset manager</p> }]}
    onOpenSettings={openSettings}
    onSelectModule={() => undefined}
    settingsDisabled={settingsDisabled}
  />;
  await mount(renderShell(false));
  await act(() => container!.querySelector<HTMLButtonElement>(".application-navigation-settings")!.click());
  await act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", ctrlKey: true, cancelable: true })));
  expect(openSettings).toHaveBeenCalledTimes(2);
  await act(() => root!.render(<LocaleProvider>{renderShell(true)}</LocaleProvider>));
  expect(container!.querySelector<HTMLButtonElement>(".application-navigation-settings")!.disabled).toBe(true);
  await act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", ctrlKey: true })));
  expect(openSettings).toHaveBeenCalledTimes(2);
});

it("activates a settings controller without displaying or selecting its module", async () => {
  const started = vi.fn();
  const stopped = vi.fn();
  function SettingsController() {
    useEffect(() => { started(); return stopped; }, []);
    return createPortal(<div role="dialog">Global settings</div>, document.body);
  }
  function Fixture() {
    const [open, setOpen] = useState(false);
    return <ApplicationShell activeModuleId="launcher" onSelectModule={() => undefined} onOpenSettings={() => setOpen(true)} modules={[
      { id: "launcher", label: "Launcher", icon: "box", content: <p>Launcher</p> },
      { id: "assets", label: "Assets", icon: "grid", keepEffectsActive: open, content: open ? <SettingsController /> : null },
    ]} />;
  }
  await mount(<Fixture />);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await act(() => container!.querySelector<HTMLButtonElement>(".application-navigation-settings")!.click());
  expect(document.querySelector('[role="dialog"]')?.textContent).toBe("Global settings");
  expect(container!.querySelector<HTMLDivElement>('[data-application-view="assets"]')!.hidden).toBe(true);
  expect(container!.querySelector('[data-application-module="launcher"]')!.getAttribute("aria-current")).toBe("page");
  expect(started).toHaveBeenCalledTimes(1);
  expect(stopped).not.toHaveBeenCalled();
});
