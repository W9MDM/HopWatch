-- Record the RF<->MQTT patcher in bridge_log, including its refusals.
--
-- bridge_log previously only described MQTT-to-MQTT federation, so its direction ENUM was
-- ('out','in') = local-to-peer / peer-to-local. The patcher (the other sanctioned bridge) wrote
-- nothing at all: a successful RF->MQTT uplink left no record, and a refusal (no channel key, no
-- resolvable local broker root) went to a console line and then marked the message handled, so a
-- message the operator asked to bridge silently was not, with nothing in the UI to say why.
--
-- rf_to_mqtt / mqtt_to_rf are the patcher's two directions; skip is a refusal, with the reason in
-- dest_topic. The table is small and unpartitioned, so widening the ENUM is cheap.
ALTER TABLE bridge_log
  MODIFY direction ENUM('out','in','rf_to_mqtt','mqtt_to_rf','skip') NOT NULL;
