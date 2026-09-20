// Resolving a channel's WIRE name.
//
// A Meshtastic channel whose settings.name is empty is not nameless: the firmware resolves it at
// every use site through Channels::getName (Channels.cpp), which substitutes the modem preset's
// display name when config.lora.use_preset is set, and "Custom" when it is not. That resolved
// string is the channel's real identity: it is what Channels::generateHash xor-folds into the
// 8-bit channel hash on the wire, and what MQTT.cpp publishes as ServiceEnvelope.channel_id via
// getGlobalId. Substituting a placeholder of our own ("(primary)", "ch1") therefore does not just
// mislabel the channel, it names a channel that does not exist: its hash differs, and a TX lookup
// keyed on the name misses.
//
// Strings are byte-exact copies of DisplayFormatters::getModemPresetDisplayName (long form).
const PRESET_NAMES: Record<string, string> = {
  SHORT_TURBO: "ShortTurbo",
  SHORT_SLOW: "ShortSlow",
  SHORT_FAST: "ShortFast",
  MEDIUM_SLOW: "MediumSlow",
  MEDIUM_FAST: "MediumFast",
  LONG_SLOW: "LongSlow",
  LONG_FAST: "LongFast",
  LONG_TURBO: "LongTurbo",
  LONG_MODERATE: "LongMod",
};

/**
 * The display name the firmware uses for a modem preset, given the preset's enum NAME as
 * readNodeConfig reports it. Presets outside the switch (VERY_LONG_SLOW, UNSET) resolve to
 * "Invalid", exactly as the firmware's default arm does.
 */
export function modemPresetDisplayName(preset: string | undefined, usePreset = true): string {
  if (!usePreset) return "Custom";
  return PRESET_NAMES[String(preset ?? "")] ?? "Invalid";
}

/**
 * A channel's wire name: its own settings.name, or the modem-preset substitution the firmware
 * applies to an empty one. Never a placeholder.
 */
export function channelWireName(name: string, modemPreset: string | undefined, usePreset = true): string {
  return name || modemPresetDisplayName(modemPreset, usePreset);
}
