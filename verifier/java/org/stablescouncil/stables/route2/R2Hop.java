package org.stablescouncil.stables.route2;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.stablescouncil.stables.route2.R2Codec.In;
import org.stablescouncil.stables.route2.R2Codec.Out;
import org.stablescouncil.stables.route2.R2Codec.R2Exception;

/** One hop line (trace-design.md 13.4): spends 1..4 parent coins, signed once by each parent's one-use key. */
public final class R2Hop {
    public final byte[] token;
    public final List<byte[]> parents;
    public final byte[] recvPub;
    public final long recvAmount;
    public final byte[] changePub;
    public final long changeAmount;
    public final byte[] body;
    private final byte[][] signatures;

    public R2Hop(byte[] token,List<byte[]> parents,byte[] recvPub,long recvAmount,byte[] changePub,long changeAmount)throws R2Exception{
        this.token=token.clone();this.parents=new ArrayList<>();for(byte[] p:parents)this.parents.add(p.clone());
        this.recvPub=recvPub.clone();this.recvAmount=recvAmount;
        this.changePub=changePub==null?null:changePub.clone();this.changeAmount=changePub==null?0:changeAmount;
        Out o=new Out().ascii("STR2H").u8(R2Codec.VERSION).raw(this.token).u8(this.parents.size());
        for(byte[] p:this.parents)o.raw(p);
        o.raw(this.recvPub).u64(recvAmount);
        if(changePub==null)o.u8(0);else o.u8(1).raw(this.changePub).u64(changeAmount);
        body=o.bytes();signatures=new byte[this.parents.size()][];
        checkShape();
    }

    private void checkShape()throws R2Exception{
        if(token.length!=32)throw R2Codec.fail("hop","token");
        if(isNative(token))throw R2Codec.fail("hop","native Minima is never a coin token");
        if(parents.isEmpty()||parents.size()>R2Codec.MAX_PARENTS)throw R2Codec.fail("hop","parent count");
        Set<String> seen=new HashSet<>();
        for(byte[] p:parents)if(p.length!=32||!seen.add(R2Codec.hex(p)))throw R2Codec.fail("hop","parents must be distinct 32-byte ids");
        R2Codec.p256(recvPub);
        if(recvAmount<=0)throw R2Codec.fail("hop","received amount");
        if(changePub!=null){
            R2Codec.p256(changePub);
            if(changeAmount<=0)throw R2Codec.fail("hop","change amount");
            if(Arrays.equals(recvPub,changePub))throw R2Codec.fail("hop","received and change keys must differ");
        }
        if(recvAmount+changeAmount<recvAmount)throw R2Codec.fail("hop","overflow");
    }
    static boolean isNative(byte[] token){for(int i=0;i<token.length;i++)if(token[i]!=0)return false;return true;}

    public long total(){return recvAmount+changeAmount;}
    public byte[] bodyHash(){return R2Codec.sha256(body);}
    public byte[] recvId(){return R2Codec.sha256(body,new byte[]{1});}
    public byte[] changeId(){return changePub==null?null:R2Codec.sha256(body,new byte[]{2});}
    public byte[] signature(int i){return signatures[i]==null?null:signatures[i].clone();}
    public void setSignature(int i,byte[] der)throws R2Exception{
        if(der==null||der.length<8||der.length>72)throw R2Codec.fail("hop","signature size");
        signatures[i]=der.clone();
    }
    public boolean signed(){for(byte[] s:signatures)if(s==null)return false;return true;}

    public byte[] wire()throws R2Exception{
        if(!signed())throw R2Codec.fail("hop","unsigned hop");
        Out o=new Out().var16(body);for(byte[] s:signatures)o.u8(s.length).raw(s);return o.bytes();
    }
    static R2Hop read(In in)throws R2Exception{
        byte[] body=in.var16(1024);R2Hop h=parseBody(body);
        for(int i=0;i<h.parents.size();i++)h.setSignature(i,in.raw(in.u8()));
        return h;
    }
    public static R2Hop parseBody(byte[] body)throws R2Exception{
        In in=new In(body);in.magic("STR2H");
        byte[] token=in.raw(32);int n=in.u8();if(n<1||n>R2Codec.MAX_PARENTS)throw R2Codec.fail("hop","parent count");
        List<byte[]> parents=new ArrayList<>();for(int i=0;i<n;i++)parents.add(in.raw(32));
        byte[] recv=in.raw(65);long amount=in.u64();int has=in.u8();
        byte[] change=null;long changeAmount=0;
        if(has==1){change=in.raw(65);changeAmount=in.u64();}else if(has!=0)throw R2Codec.fail("hop","change flag");
        in.end();
        R2Hop h=new R2Hop(token,parents,recv,amount,change,changeAmount);
        if(!Arrays.equals(h.body,body))throw R2Codec.fail("hop","non-canonical body");
        return h;
    }
    public static R2Hop fromWire(byte[] wire)throws R2Exception{In in=new In(wire);R2Hop h=read(in);in.end();return h;}
}
