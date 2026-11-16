import {create} from "zustand";
import {fetchPublicSettings,type PublicSettings} from "@/services/api/admin";
import {useUserStore} from "@/stores/use-user-store";
import {isAdminRole} from "../../../shared/roles";

type SiteStore = {settings:PublicSettings|null;error:string;load:()=>Promise<void>};
export const useSiteStore=create<SiteStore>((set)=>({
    settings:null,error:"",
    load:async()=>{try{set({settings:await fetchPublicSettings(),error:""});}catch(error){set({error:error instanceof Error?error.message:"公共内容加载失败"});}},
}));
export const privateChannelsHidden = () => {
    const user = useUserStore.getState().user;
    return !user?.isAdmin && !isAdminRole(user?.role) && useSiteStore.getState().settings?.hidePrivateChannels === true;
};
