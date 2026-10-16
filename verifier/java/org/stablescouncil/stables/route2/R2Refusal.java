package org.stablescouncil.stables.route2;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.stablescouncil.stables.route2.R2Codec.In;
import org.stablescouncil.stables.route2.R2Codec.Out;
import org.stablescouncil.stables.route2.R2Codec.R2Exception;

/**
 * A receiver's signed refusal of one of its own requests, and the payer's refund package (founder 2026-10-15/16,
 * FAILED_PAYMENTS_SESSION_PROMPT.md layer 3). A payment signed in a touch that broke off may never have reached the
 * receiver. Asked over the network, a receiver that never got it first marks that request refused for good (it never
 * credits it afterwards), then signs this statement with the request's own one-use key. The hardware destroys that key
 * in the signature, so the coin paid to the request can never be spent, exited or refused a second time: the refund
 * takes nothing from anyone. The payer takes the refusal to the Council with the bundle it signed, through the same
 * exit path as a Remove, and the amount goes back to the payer's Savings.
 *
 *   body    "STR2N" | ver | requestKeyHash (32) | payout (32) | nonce (16)                         (86 bytes)
 *   wire    body (var16) | signature (u8 + DER) | the request key's attestation: leaf (var16), chain (u8 + var16 each)
 *   package "STR2F" | ver | refusal wire (var16) | the payer's bundle (every chain carried) to the end
 *
 * The payout is the Savings address the payer gave at first contact (R2Limits.Intent v2), so a refusal read by anyone
 * on the network pays only the payer it was made for.
 */
public final class R2Refusal {
    public static final int BODY_SIZE=86;
    public final byte[] keyHash,payout,nonce,body;
    private byte[] signature,leaf;private List<byte[]> chain;

    public R2Refusal(byte[] keyHash,byte[] payout,byte[] nonce)throws R2Exception{
        if(keyHash==null||payout==null||nonce==null||keyHash.length!=32||payout.length!=32||nonce.length!=16)throw R2Codec.fail("refusal","shape");
        this.keyHash=keyHash.clone();this.payout=payout.clone();this.nonce=nonce.clone();
        body=new Out().ascii("STR2N").u8(R2Codec.VERSION).raw(keyHash).raw(payout).raw(nonce).bytes();
    }
    public static R2Refusal parseBody(byte[] body)throws R2Exception{
        In in=new In(body);in.magic("STR2N");
        R2Refusal r=new R2Refusal(in.raw(32),in.raw(32),in.raw(16));in.end();
        if(!Arrays.equals(r.body,body))throw R2Codec.fail("refusal","non-canonical body");
        return r;
    }
    public byte[] signature(){return signature==null?null:signature.clone();}
    public byte[] leaf(){return leaf==null?null:leaf.clone();}
    public List<byte[]> chain(){return chain==null?null:new ArrayList<>(chain);}
    /** The signature by the request key, and that key's attestation (leaf and chain) so a checker can verify it. */
    public R2Refusal sign(byte[] der,byte[] leaf,List<byte[]> chain)throws R2Exception{
        if(der==null||der.length<8||der.length>72)throw R2Codec.fail("refusal","signature size");
        if(leaf==null||leaf.length==0||leaf.length>R2Codec.MAX_CERT||chain==null||chain.size()>R2Codec.MAX_CERTS)throw R2Codec.fail("refusal","attestation shape");
        for(byte[] c:chain)if(c.length>R2Codec.MAX_CERT)throw R2Codec.fail("refusal","attestation shape");
        signature=der.clone();this.leaf=leaf.clone();this.chain=new ArrayList<>();for(byte[] c:chain)this.chain.add(c.clone());
        return this;
    }
    public byte[] wire()throws R2Exception{
        if(signature==null)throw R2Codec.fail("refusal","unsigned refusal");
        Out o=new Out().var16(body).u8(signature.length).raw(signature).var16(leaf).u8(chain.size());
        for(byte[] c:chain)o.var16(c);
        return o.bytes();
    }
    public static R2Refusal fromWire(byte[] wire)throws R2Exception{
        In in=new In(wire);R2Refusal r=parseBody(in.var16(BODY_SIZE));byte[] sig=in.raw(in.u8());byte[] leaf=in.var16(R2Codec.MAX_CERT);
        int n=in.u8();if(n>R2Codec.MAX_CERTS)throw R2Codec.fail("limit","refusal chain");
        List<byte[]> chain=new ArrayList<>();for(int i=0;i<n;i++)chain.add(in.var16(R2Codec.MAX_CERT));
        in.end();return r.sign(sig,leaf,chain);
    }
    /** The verdict a holder of the request key's point can reach alone: signed by that key, for that request. */
    public boolean signedBy(byte[] point){return signature!=null&&Arrays.equals(R2Codec.keyHash(point),keyHash)&&R2Codec.verify(point,body,signature);}

    /** The refund package: the refusal and the payer's bundle (the hop paying the refused request, every chain carried). */
    public static byte[] pack(R2Refusal refusal,byte[] bundle)throws R2Exception{
        byte[] p=new Out().ascii("STR2F").u8(R2Codec.VERSION).var16(refusal.wire()).raw(bundle).bytes();
        if(p.length>R2Exit.MAX_PACKAGE)throw R2Codec.fail("limit","refund package over "+R2Exit.MAX_PACKAGE+" bytes");
        return p;
    }
    public static final class Package { public final R2Refusal refusal;public final byte[] bundle,hash;
        Package(R2Refusal r,byte[] b,byte[] h){refusal=r;bundle=b;hash=h;} }
    public static Package unpack(byte[] p)throws R2Exception{
        if(p.length>R2Exit.MAX_PACKAGE)throw R2Codec.fail("limit","refund package size");
        In in=new In(p);in.magic("STR2F");byte[] wire=in.var16(R2Exit.MAX_PACKAGE);
        R2Refusal r=fromWire(wire);int head=5+1+2+wire.length;
        return new Package(r,Arrays.copyOfRange(p,head,p.length),R2Codec.sha256(p));
    }
    /** True when these bytes are a refund package (the Council tells them from an exit package by the magic). */
    public static boolean isPackage(byte[] p){return p!=null&&p.length>6&&p[0]=='S'&&p[1]=='T'&&p[2]=='R'&&p[3]=='2'&&p[4]=='F';}
}
