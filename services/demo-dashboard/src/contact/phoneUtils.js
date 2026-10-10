import { phoneService } from '../platform/PhoneService.js';

// Mainland China is the only region this system serves.
const DEFAULT_REGION = Object.freeze({ countryCode: 'CN', phoneCountryCode: '86' });

export function normalizePhoneDetailed(value, region = DEFAULT_REGION, options = {}) {
  const profile = { ...DEFAULT_REGION, ...(region && typeof region === 'object' ? region : {}) };
  const result = phoneService.normalize(value, {
    countryCode: profile.countryCode,
    phoneCountryCode: profile.phoneCountryCode,
    nationalPhonePrefix: profile.nationalPhonePrefix,
    nationalPhoneLengths: profile.nationalPhoneLengths,
    allowNationalWithoutPrefix: profile.allowNationalWithoutPrefix === true,
    internationalFormat: options.internationalFormat === true
  });
  if (!result) return null;
  return {
    normalized_value: result.compatibility_value,
    normalization_certainty: result.normalization_certainty,
    normalization_status: result.normalization_status,
    country_code: result.country
  };
}

export function normalizePhone(value, region, options) {
  return normalizePhoneDetailed(value, region, options)?.normalized_value || null;
}

export function normalizePhoneWithContext(value, region, options) {
  const result = normalizePhoneDetailed(value, region, options);
  return result || { normalized_value: null, normalization_status: 'INVALID', normalization_certainty: 'INVALID', country_code: null };
}
