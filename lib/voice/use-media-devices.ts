"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Microphone and speaker device selection.
 *
 * `enumerateDevices` only returns real labels once a microphone permission has been granted, so
 * `refresh()` is called after the session starts rather than on mount; until then the options are
 * placeholders.
 *
 * Output selection uses `HTMLMediaElement.setSinkId`, which is not in every browser. Where it is
 * missing the picker is hidden rather than offered and then ignored.
 */

export interface MediaDeviceOption {
  deviceId: string;
  label: string;
}

export interface MediaDevicesResult {
  inputs: MediaDeviceOption[];
  outputs: MediaDeviceOption[];
  selectedInputId: string;
  selectedOutputId: string;
  /** True when the browser exposes `setSinkId`. */
  canSelectOutput: boolean;
  /** Re-enumerates. Safe to call before permission is granted. */
  refresh(): Promise<void>;
  selectInput(deviceId: string): void;
  selectOutput(deviceId: string): Promise<boolean>;
  /** Applies the chosen output to a media element, if selection is supported. */
  applyOutput(element: HTMLMediaElement | null): Promise<boolean>;
}

function supportsSinkId(element: HTMLMediaElement | null | undefined): boolean {
  return typeof (element as { setSinkId?: unknown } | null)?.setSinkId === "function";
}

/** Names the default devices so the pickers never show a blank list. */
function fallbackLabel(device: MediaDeviceInfo, index: number): string {
  if (device.deviceId === "default") return "System default";
  if (device.deviceId === "communications") return "System default (communications)";
  return device.kind === "videoinput" ? `Camera ${index + 1}` : `Microphone ${index + 1}`;
}

export function useMediaDevices(): MediaDevicesResult {
  const [inputs, setInputs] = useState<MediaDeviceOption[]>([]);
  const [outputs, setOutputs] = useState<MediaDeviceOption[]>([]);
  const [selectedInputId, setSelectedInputId] = useState("");
  const [selectedOutputId, setSelectedOutputId] = useState("");
  const [canSelectOutput, setCanSelectOutput] = useState(false);

  const refresh = useCallback(async () => {
    const devices = navigator.mediaDevices;
    if (!devices?.enumerateDevices) return;

    const all = await devices.enumerateDevices();
    const nextInputs: MediaDeviceOption[] = [];
    const nextOutputs: MediaDeviceOption[] = [];

    all.forEach((device, index) => {
      const label = device.label || fallbackLabel(device, index);
      if (device.kind === "audioinput") nextInputs.push({ deviceId: device.deviceId, label });
      if (device.kind === "audiooutput") nextOutputs.push({ deviceId: device.deviceId, label });
    });

    setInputs(nextInputs);
    setOutputs(nextOutputs);

    // Default to the first available device when nothing is chosen yet, so the pickers show a
    // selection rather than appearing blank.
    setSelectedInputId((current) => current || nextInputs.find((d) => d.deviceId === "default")?.deviceId || nextInputs[0]?.deviceId || "");
    setSelectedOutputId((current) => current || nextOutputs.find((d) => d.deviceId === "default")?.deviceId || nextOutputs[0]?.deviceId || "");
  }, []);

  useEffect(() => {
    const devices = navigator.mediaDevices;
    if (!devices) return;

    void refresh();
    // Devices can be plugged in mid-session, so the list is refreshed on the event too.
    devices.addEventListener?.("devicechange", refresh);
    return () => devices.removeEventListener?.("devicechange", refresh);
  }, [refresh]);

  const selectInput = useCallback((deviceId: string) => {
    setSelectedInputId(deviceId);
  }, []);

  const applyOutput = useCallback(
    async (element: HTMLMediaElement | null) => {
      if (!element || !selectedOutputId) return false;
      const sink = element as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };
      if (typeof sink.setSinkId !== "function") return false;
      try {
        await sink.setSinkId(selectedOutputId);
        return true;
      } catch {
        // A device can disappear between enumeration and selection. Not worth surfacing.
        return false;
      }
    },
    [selectedOutputId],
  );

  const selectOutput = useCallback(
    async (deviceId: string) => {
      setSelectedOutputId(deviceId);
      return true;
    },
    [],
  );

  // Probe support once the session has an audio element to inspect.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const probe = document.createElement("audio");
    setCanSelectOutput(supportsSinkId(probe));
  }, []);

  return { inputs, outputs, selectedInputId, selectedOutputId, canSelectOutput, refresh, selectInput, selectOutput, applyOutput };
}