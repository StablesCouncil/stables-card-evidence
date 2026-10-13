package org.stablescouncil.stables.route2;

import java.io.ByteArrayInputStream;
import java.math.BigInteger;
import java.security.PublicKey;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.stablescouncil.stables.route2.R2Codec.R2Exception;

/**
 * Coin-key attestation check (trace-design.md 13.6). A key is accepted only when its certificate chain reaches a pinned
 * Google root and its KeyDescription shows, in hardwareEnforced: EC P-256 signing, usage count limit 1, origin
 * GENERATED, and a locked device with verified boot (or a self-signed boot key on the explicit allowlist).
 * Validity dates are deliberately not enforced: TEE attestation intermediates live about two weeks
 * (ROUTE2-KEYSTORE-03) and a coin must stay checkable for its whole life.
 */
public final class R2Attestation {
    static final String KEY_DESCRIPTION_OID="1.3.6.1.4.1.11129.2.1.17";
    static final int TAG_PURPOSE=1,TAG_ALGORITHM=2,TAG_EC_CURVE=10,TAG_USAGE_COUNT=405,TAG_ORIGIN=702,TAG_ROOT_OF_TRUST=704,TAG_APP_ID=709;
    static final int PURPOSE_SIGN=2,ALGORITHM_EC=3,CURVE_P256=1,ORIGIN_GENERATED=0;
    static final int BOOT_VERIFIED=0,BOOT_SELF_SIGNED=1;
    public static final int LEVEL_SOFTWARE=0,LEVEL_TEE=1,LEVEL_STRONGBOX=2;

    /** GrapheneOS verified-boot key hashes (SHA-256 of the boot public key), published at grapheneos.org/install. */
    public static final Map<String,String> GRAPHENEOS_BOOT_KEYS;
    static{
        Map<String,String> m=new HashMap<>();
        m.put("3efe5392be3ac38afb894d13de639e521675e62571a8a9b3ef9fc8c44fd17fa1","GrapheneOS Pixel 7 (panther)");
        m.put("bc1c0dd95664604382bb888412026422742eb333071ea0b2d19036217d49182f","GrapheneOS Pixel 7 Pro (cheetah)");
        GRAPHENEOS_BOOT_KEYS=Collections.unmodifiableMap(m);
    }

    /** What an accepted key's attestation says. */
    public static final class Key {
        public final byte[] point,keyHash,chainId;
        public final int securityLevel,bootState;
        public final String bootKey;
        Key(byte[] point,byte[] chainId,int level,int bootState,String bootKey){
            this.point=point;this.keyHash=R2Codec.keyHash(point);this.chainId=chainId;this.securityLevel=level;this.bootState=bootState;this.bootKey=bootKey;
        }
    }

    private final Set<String> pinnedSpki;
    private final List<PublicKey> pinnedKeys;
    private final Map<String,String> selfSignedBootKeys;
    private final Set<String> revoked;

    /** Production verifier: Google roots, GrapheneOS allowlist, optional revoked-serial snapshot (hex or decimal). */
    public static R2Attestation production(Set<String> revokedSerials)throws R2Exception{
        List<X509Certificate> roots=new ArrayList<>();
        for(String b:R2Roots.DER_BASE64)roots.add(cert(Base64.getDecoder().decode(b)));
        return new R2Attestation(roots,GRAPHENEOS_BOOT_KEYS,revokedSerials);
    }
    /** Explicit roots: tests sign synthetic chains with their own root to exercise each policy rule in isolation. */
    public R2Attestation(List<X509Certificate> roots,Map<String,String> selfSignedBootKeys,Set<String> revokedSerials){
        Set<String> spki=new HashSet<>();List<PublicKey> keys=new ArrayList<>();
        for(X509Certificate r:roots){spki.add(R2Codec.hex(R2Codec.sha256(r.getPublicKey().getEncoded())));keys.add(r.getPublicKey());}
        pinnedSpki=spki;pinnedKeys=keys;
        this.selfSignedBootKeys=selfSignedBootKeys==null?Collections.<String,String>emptyMap():selfSignedBootKeys;
        this.revoked=revokedSerials==null?Collections.<String>emptySet():revokedSerials;
    }

    static X509Certificate cert(byte[] der)throws R2Exception{
        try{return (X509Certificate)CertificateFactory.getInstance("X.509").generateCertificate(new ByteArrayInputStream(der));}
        catch(Exception e){throw R2Codec.fail("attestation","certificate does not parse");}
    }
    public static byte[] chainId(List<byte[]> chain){
        R2Codec.Out o=new R2Codec.Out();for(byte[] c:chain)o.var16(c);return R2Codec.sha256(o.bytes());
    }

    /** Certificates above the leaf, leaf issuer first. Throws with the first broken rule. */
    public void verifyChain(List<byte[]> chain)throws R2Exception{
        if(chain.isEmpty()||chain.size()>R2Codec.MAX_CERTS)throw R2Codec.fail("attestation","chain length");
        List<X509Certificate> certs=new ArrayList<>();for(byte[] d:chain)certs.add(cert(d));
        for(X509Certificate c:certs)checkRevoked(c);
        for(int i=0;i+1<certs.size();i++)if(!signedBy(certs.get(i),certs.get(i+1).getPublicKey()))throw R2Codec.fail("attestation","chain link "+i+" not signed by its issuer");
        X509Certificate top=certs.get(certs.size()-1);
        if(pinnedSpki.contains(R2Codec.hex(R2Codec.sha256(top.getPublicKey().getEncoded()))))return;
        for(PublicKey root:pinnedKeys)if(signedBy(top,root))return;
        throw R2Codec.fail("attestation","chain does not reach a pinned Google root");
    }
    private void checkRevoked(X509Certificate c)throws R2Exception{
        BigInteger s=c.getSerialNumber();
        if(revoked.contains(R2Codec.serialKey(s))||revoked.contains(s.toString()))throw R2Codec.fail("attestation","revoked certificate "+R2Codec.serialKey(s));
    }
    private static boolean signedBy(X509Certificate c,PublicKey issuer){try{c.verify(issuer);return true;}catch(Exception e){return false;}}

    /** Full check of one key: leaf signed by the chain's first certificate, chain to a pin, then the KeyDescription policy. */
    public Key verifyKey(byte[] leafDer,List<byte[]> chain)throws R2Exception{
        verifyChain(chain);
        X509Certificate leaf=cert(leafDer);
        checkRevoked(leaf);
        if(!signedBy(leaf,cert(chain.get(0)).getPublicKey()))throw R2Codec.fail("attestation","leaf not signed by its issuer");
        byte[] point=R2Codec.pointOf(leaf.getPublicKey());
        byte[] ext=leaf.getExtensionValue(KEY_DESCRIPTION_OID);
        if(ext==null)throw R2Codec.fail("attestation","no key attestation extension");
        return policy(point,ext,chainId(chain));
    }

    Key policy(byte[] point,byte[] extensionValue,byte[] chainId)throws R2Exception{
        Der outer=Der.at(extensionValue,0);
        if(outer.tag!=0x04||outer.end!=extensionValue.length)throw R2Codec.fail("attestation","extension wrapper");
        Der desc=Der.at(extensionValue,outer.start);
        if(desc.tag!=0x30||desc.end!=outer.end)throw R2Codec.fail("attestation","KeyDescription");
        List<Der> f=desc.children();
        if(f.size()<8)throw R2Codec.fail("attestation","KeyDescription fields");
        int attLevel=(int)f.get(1).integer(),kmLevel=(int)f.get(3).integer();
        if(attLevel==LEVEL_SOFTWARE||kmLevel!=attLevel)throw R2Codec.fail("attestation","not attested by secure hardware (level "+attLevel+"/"+kmLevel+")");
        Map<Integer,Der> hw=authorizations(f.get(7));
        authorizations(f.get(6));
        if(!hw.containsKey(TAG_USAGE_COUNT))throw R2Codec.fail("attestation","one-use limit not enforced in hardware");
        if(explicitInt(hw.get(TAG_USAGE_COUNT))!=1)throw R2Codec.fail("attestation","usage count limit is not 1");
        if(!hw.containsKey(TAG_ORIGIN)||explicitInt(hw.get(TAG_ORIGIN))!=ORIGIN_GENERATED)throw R2Codec.fail("attestation","key not generated inside the hardware");
        if(!hw.containsKey(TAG_ALGORITHM)||explicitInt(hw.get(TAG_ALGORITHM))!=ALGORITHM_EC)throw R2Codec.fail("attestation","not an EC key");
        if(!hw.containsKey(TAG_EC_CURVE)||explicitInt(hw.get(TAG_EC_CURVE))!=CURVE_P256)throw R2Codec.fail("attestation","not P-256");
        boolean sign=false;
        if(hw.containsKey(TAG_PURPOSE))for(Der p:hw.get(TAG_PURPOSE).only().children())if(p.integer()==PURPOSE_SIGN)sign=true;
        if(!sign)throw R2Codec.fail("attestation","no hardware SIGN purpose");
        if(!hw.containsKey(TAG_ROOT_OF_TRUST))throw R2Codec.fail("attestation","no hardware root of trust");
        List<Der> rot=hw.get(TAG_ROOT_OF_TRUST).only().children();
        if(rot.size()<3||rot.get(0).tag!=0x04||rot.get(1).tag!=0x01||rot.get(2).tag!=0x0a)throw R2Codec.fail("attestation","root of trust shape");
        String bootKey=R2Codec.hex(rot.get(0).value());
        boolean locked=rot.get(1).value().length==1&&rot.get(1).value()[0]!=0;
        int boot=(int)rot.get(2).integer();
        if(!locked)throw R2Codec.fail("attestation","bootloader unlocked");
        if(boot==BOOT_SELF_SIGNED){
            if(!selfSignedBootKeys.containsKey(bootKey))throw R2Codec.fail("attestation","self-signed boot key not on the allowlist");
        }else if(boot!=BOOT_VERIFIED)throw R2Codec.fail("attestation","verified boot state "+boot);
        return new Key(point,chainId,attLevel,boot,bootKey);
    }

    /** AuthorizationList: context-tagged explicit fields; a duplicated tag is refused. */
    private static Map<Integer,Der> authorizations(Der list)throws R2Exception{
        if(list.tag!=0x30)throw R2Codec.fail("attestation","AuthorizationList");
        Map<Integer,Der> m=new HashMap<>();
        for(Der a:list.children()){
            if(!a.contextConstructed)throw R2Codec.fail("attestation","authorization tag class");
            if(m.put(a.tag,a)!=null)throw R2Codec.fail("attestation","duplicate authorization "+a.tag);
        }
        return m;
    }
    private static long explicitInt(Der tagged)throws R2Exception{return tagged.only().integer();}

    /** Minimal strict DER reader. */
    static final class Der {
        final byte[] d;final int tag,start,end;final boolean contextConstructed;
        private Der(byte[] d,int tag,int start,int end,boolean cc){this.d=d;this.tag=tag;this.start=start;this.end=end;this.contextConstructed=cc;}
        static Der at(byte[] d,int p)throws R2Exception{
            try{
                int first=d[p++]&255;int tag=first;boolean cc=(first&0xe0)==0xa0;
                if(cc){tag=first&0x1f;if(tag==0x1f){tag=0;int c;int n=0;do{c=d[p++]&255;tag=(tag<<7)|(c&0x7f);if(++n>4)throw R2Codec.fail("attestation","tag");}while((c&0x80)!=0);}}
                int len=d[p++]&255;
                if((len&0x80)!=0){int n=len&0x7f;if(n<1||n>3)throw R2Codec.fail("attestation","length");len=0;for(int i=0;i<n;i++)len=(len<<8)|(d[p++]&255);}
                if(len<0||p+len>d.length)throw R2Codec.fail("attestation","length");
                return new Der(d,tag,p,p+len,cc);
            }catch(ArrayIndexOutOfBoundsException e){throw R2Codec.fail("attestation","truncated DER");}
        }
        List<Der> children()throws R2Exception{List<Der> l=new ArrayList<>();for(int p=start;p<end;){Der x=at(d,p);if(x.end>end)throw R2Codec.fail("attestation","nesting");l.add(x);p=x.end;}return l;}
        Der only()throws R2Exception{List<Der> c=children();if(c.size()!=1)throw R2Codec.fail("attestation","explicit tag content");return c.get(0);}
        byte[] value(){byte[] v=new byte[end-start];System.arraycopy(d,start,v,0,v.length);return v;}
        long integer()throws R2Exception{
            if((tag!=0x02&&tag!=0x0a)||end-start<1||end-start>8)throw R2Codec.fail("attestation","integer");
            try{return new BigInteger(value()).longValueExact();}catch(ArithmeticException e){throw R2Codec.fail("attestation","integer range");}
        }
    }
}
