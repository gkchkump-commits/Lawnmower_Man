import { describe, it, expect } from 'vitest';
import { child, children, findAll, parseXml, path, textOf, toNumber } from '../../../electron/tapo/xml.js';

const PROFILES = `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema">
  <!-- a comment -->
  <SOAP-ENV:Body>
    <trt:GetProfilesResponse>
      <trt:Profiles fixed="true" token="profile_1">
        <tt:Name>mainStream</tt:Name>
        <tt:VideoEncoderConfiguration token="main"><tt:Encoding>H264</tt:Encoding></tt:VideoEncoderConfiguration>
      </trt:Profiles>
      <ns2:Profiles xmlns:ns2="http://www.onvif.org/ver10/media/wsdl" token="profile_2"><tt:Name>minorStream</tt:Name></ns2:Profiles>
    </trt:GetProfilesResponse>
  </SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;

describe('parseXml', () => {
  it('matches by local name, whatever the prefix', () => {
    const root = parseXml(PROFILES);
    expect(root.name).toBe('Envelope');
    expect(root.prefix).toBe('SOAP-ENV');
    const resp = path(root, 'Body/GetProfilesResponse');
    const profiles = children(resp, 'Profiles');
    expect(profiles.map((p) => p.attrs.token)).toEqual(['profile_1', 'profile_2']);
    expect(profiles[1].prefix).toBe('ns2');
    expect(textOf(profiles[0], 'Name')).toBe('mainStream');
    expect(textOf(root, 'Body/GetProfilesResponse/Profiles/VideoEncoderConfiguration/Encoding')).toBe('H264');
    expect(path(root, 'Body/Nope/Profiles')).toBeNull();
    expect(textOf(root, 'Body/Nope')).toBeNull();
    expect(findAll(root, 'Name').map((n) => n.text)).toEqual(['mainStream', 'minorStream']);
    expect(child(root, 'Body')?.name).toBe('Body');
    expect('xmlns' in profiles[1].attrs).toBe(false);
  });

  it('decodes the predefined and numeric entities, and CDATA', () => {
    const r = parseXml('<a x="&quot;q&quot; &amp; &#65;&#x42;">&lt;b&gt; &apos;&amp;&apos;<![CDATA[<raw & stuff>]]></a>');
    expect(r.attrs.x).toBe('"q" & AB');
    expect(r.text).toBe("<b> '&'<raw & stuff>");
  });

  it('rejects DTDs, unknown entities and broken documents', () => {
    expect(() => parseXml('<?xml version="1.0"?><!DOCTYPE a [<!ENTITY x "boom">]><a>&x;</a>')).toThrow(/DOCTYPE/);
    expect(() => parseXml('<a>&nbsp;</a>')).toThrow(/unknown entity/);
    expect(() => parseXml('<a>fish & chips</a>')).toThrow(/stray/);
    expect(() => parseXml('<a><b></a>')).toThrow(/does not close/);
    expect(() => parseXml('<a>')).toThrow(/not closed/);
    expect(() => parseXml('<a/><b/>')).toThrow(/more than one root/);
    expect(() => parseXml('<a x=1/>')).toThrow(/not quoted/);
    expect(() => parseXml('')).toThrow(/no root/);
    expect(() => parseXml('garbage')).toThrow(/outside the root/);
  });

  it('caps the size and the depth', () => {
    expect(() => parseXml(`<a>${'x'.repeat(2000)}</a>`, { maxBytes: 1000 })).toThrow(/larger than 1000/);
    expect(() => parseXml('<a>'.repeat(200) + '</a>'.repeat(200))).toThrow(/deeper than/);
    expect(parseXml('<a>'.repeat(50) + '</a>'.repeat(50)).name).toBe('a');
  });

  it('toNumber', () => {
    expect(toNumber(' 0.25 ')).toBe(0.25);
    expect(toNumber('')).toBeNull();
    expect(toNumber('abc')).toBeNull();
    expect(toNumber(null)).toBeNull();
  });
});
