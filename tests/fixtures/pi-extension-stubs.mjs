// Minimal stand-ins for Pi-provided extension modules (typebox, pi-ai) so the
// companion can be bundled and exercised in tests without Pi installed here.
const schema = kind => (...args) => ({ kind, args })
export const Type = {
  Object: schema('Object'),
  Optional: value => ({ optional: true, value }),
  String: schema('String'),
  Number: schema('Number'),
  Boolean: schema('Boolean'),
}
export const StringEnum = values => ({ kind: 'StringEnum', values })
