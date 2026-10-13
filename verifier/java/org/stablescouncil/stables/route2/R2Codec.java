package org.stablescouncil.stables.route2;

import java.io.ByteArrayOutputStream;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.util.Arrays;
import java.util.Locale;

/** Route 2 wire encoding (trace-design.md section 13.2). Pure Java: shared by the app and its JVM tests. */
public final class R2Codec {
    public static final int VERSION=1;
    public static final int MAX_BUNDLE=65536,MAX_HOPS=64,MAX_ANCHORS=16,MAX_KEYS=128,MAX_CHAINS=8,MAX_CERTS=8,MAX_CERT=8192,MAX_PARENTS=4;
    public static final int RE_ANCHOR_DEPTH=10;
    public static final long ATOMS=100000000L;
    static final byte[] P256_SPKI=unhex("3059301306072a8648ce3d020106082a8648ce3d030107034200");
    private R2Codec(){}

    public static final class R2Exception extends Exception {
        public final String code;
        public R2Exception(String code,String detail){super(code+": "+detail);this.code=code;}
    }
    static R2Exception fail(String code,String detail){return new R2Exception(code,detail);}

    static final class Out {
        private final ByteArrayOutputStream b=new ByteArrayOutputStream();
        Out u8(int v){if(v<0||v>255)throw new IllegalArgumentException("u8");b.write(v);return this;}
        Out u16(int v){if(v<0||v>65535)throw new IllegalArgumentException("u16");b.write(v>>8);b.write(v&255);return this;}
        Out u64(long v){for(int i=7;i>=0;i--)b.write((int)(v>>>(8*i))&255);return this;}
        Out raw(byte[] v){b.write(v,0,v.length);return this;}
        Out ascii(String s){return raw(s.getBytes(StandardCharsets.US_ASCII));}
        Out var16(byte[] v){return u16(v.length).raw(v);}
        Out u32(int v){if(v<0)throw new IllegalArgumentException("u32");for(int i=3;i>=0;i--)b.write((v>>>(8*i))&255);return this;}
        Out var32(byte[] v){return u32(v.length).raw(v);}
        Out bool(boolean v){return u8(v?1:0);}
        Out opt(byte[] v){return v==null?u8(0):u8(1).var32(v);}
        byte[] bytes(){return b.toByteArray();}
    }
    static final class In {
        private final byte[] d;private int p;
        In(byte[] d){this.d=d;}
        private void need(int n)throws R2Exception{if(n<0||p+n>d.length)throw fail("parse","truncated");}
        int u8()throws R2Exception{need(1);return d[p++]&255;}
        int u16()throws R2Exception{need(2);int v=((d[p]&255)<<8)|(d[p+1]&255);p+=2;return v;}
        long u64()throws R2Exception{need(8);long v=0;for(int i=0;i<8;i++)v=(v<<8)|(d[p++]&255);return v;}
        byte[] raw(int n)throws R2Exception{need(n);byte[] v=Arrays.copyOfRange(d,p,p+n);p+=n;return v;}
        byte[] var16(int max)throws R2Exception{int n=u16();if(n>max)throw fail("limit","field over "+max);return raw(n);}
        int u32()throws R2Exception{need(4);int v=0;for(int i=0;i<4;i++)v=(v<<8)|(d[p++]&255);if(v<0)throw fail("parse","u32");return v;}
        byte[] var32(int max)throws R2Exception{int n=u32();if(n>max)throw fail("limit","field over "+max);return raw(n);}
        boolean bool()throws R2Exception{int v=u8();if(v>1)throw fail("parse","bool");return v==1;}
        byte[] opt(int max)throws R2Exception{return bool()?var32(max):null;}
        boolean done(){return p==d.length;}
        void magic(String m)throws R2Exception{if(!Arrays.equals(raw(m.length()),m.getBytes(StandardCharsets.US_ASCII))||u8()!=VERSION)throw fail("parse","not "+m+" v"+VERSION);}
        void end()throws R2Exception{if(p!=d.length)throw fail("parse","trailing bytes");}
    }

    public static byte[] sha256(byte[]... parts){
        try{MessageDigest m=MessageDigest.getInstance("SHA-256");for(byte[] p:parts)m.update(p);return m.digest();}
        catch(Exception e){throw new IllegalStateException(e);}
    }
    public static byte[] keyHash(byte[] point){return sha256(point);}
    public static String hex(byte[] v){StringBuilder s=new StringBuilder(v.length*2);for(byte x:v)s.append(String.format(Locale.ROOT,"%02x",x&255));return s.toString();}
    public static byte[] unhex(String s){
        if(s.startsWith("0x")||s.startsWith("0X"))s=s.substring(2);
        if(s.length()%2!=0||!s.matches("[0-9a-fA-F]*"))throw new IllegalArgumentException("hex");
        byte[] v=new byte[s.length()/2];for(int i=0;i<v.length;i++)v[i]=(byte)Integer.parseInt(s.substring(2*i,2*i+2),16);return v;
    }

    /** Exact 8-decimal token amount to atoms; refuses more decimals, signs, exponents and zero. */
    public static long atoms(String decimal)throws R2Exception{
        if(decimal==null||!decimal.matches("\\d{1,10}(\\.\\d{1,8})?"))throw fail("amount","not an exact 8-decimal amount: "+decimal);
        String[] p=decimal.split("\\.");String frac=p.length>1?p[1]:"";
        long v=Long.parseLong(p[0])*ATOMS+(frac.isEmpty()?0:Long.parseLong((frac+"00000000").substring(0,8)));
        if(v<=0)throw fail("amount","zero");return v;
    }
    public static String decimal(long atoms){
        String f=String.format(Locale.ROOT,"%08d",atoms%ATOMS).replaceAll("0+$","");
        return (atoms/ATOMS)+(f.isEmpty()?"":"."+f);
    }

    /** P-256 point (65 bytes, uncompressed) as a verifying key. */
    public static PublicKey p256(byte[] point)throws R2Exception{
        if(point.length!=65||point[0]!=4)throw fail("key","not an uncompressed P-256 point");
        try{return KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(concat(P256_SPKI,point)));}
        catch(Exception e){throw fail("key","invalid P-256 point");}
    }
    /** Uncompressed point of a P-256 SubjectPublicKeyInfo, or a refusal for any other key type. */
    public static byte[] pointOf(PublicKey key)throws R2Exception{
        byte[] spki=key.getEncoded();
        if(spki.length!=P256_SPKI.length+65||!Arrays.equals(Arrays.copyOf(spki,P256_SPKI.length),P256_SPKI))throw fail("key","not P-256");
        return Arrays.copyOfRange(spki,P256_SPKI.length,spki.length);
    }
    public static boolean verify(byte[] point,byte[] message,byte[] der){
        try{Signature s=Signature.getInstance("SHA256withECDSA");s.initVerify(p256(point));s.update(message);return s.verify(der);}
        catch(Exception e){return false;}
    }
    static byte[] concat(byte[]... parts){Out o=new Out();for(byte[] p:parts)o.raw(p);return o.bytes();}
    static String serialKey(BigInteger serial){return serial.toString(16).toLowerCase(Locale.ROOT);}
}
