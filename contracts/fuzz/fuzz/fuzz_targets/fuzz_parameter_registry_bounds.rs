#![no_main]

// libFuzzer target for the parameter_registry governance bounds.
//
// Asserts INV-PRB-1 through INV-PRB-5 on every input the fuzzer produces:
//   INV-PRB-1: out-of-bound writes never persist
//   INV-PRB-2: in-bound writes persist and read back
//   INV-PRB-3: a non-governance caller cannot mutate
//   INV-PRB-4: an unknown key id is rejected consistently
//   INV-PRB-5: proposals are bounds-checked at proposal time
//
// The input is a sequence of 12-byte records; see
// `kora_fuzz::targets::parameter_registry_bounds::BoundsOp` for the layout.
//
// Run with:
//   cargo fuzz run fuzz_parameter_registry_bounds
//
// To replay a specific corpus entry:
//   cargo fuzz run fuzz_parameter_registry_bounds corpus/parameter_registry_bounds/fixtures.bin
libfuzzer_sys::fuzz_target!(|data: &[u8]| {
    kora_fuzz::targets::parameter_registry_bounds::run(data);
});
