import {useState} from "react";
import {useQuery,useQueryClient} from "@tanstack/react-query";
import {App} from "antd";
import {adminRequest,queryPath} from "@/services/api/admin";

export function useAdminList<T>(path:string){
    const [keyword,setKeyword]=useState("");
    const [search,setSearch]=useState("");
    const query=useQuery({queryKey:["admin",path,search],queryFn:()=>adminRequest<{items:T[]}>(queryPath(path,{keyword:search}))});
    const {message}=App.useApp();
    const client=useQueryClient();
    const refresh=()=>client.invalidateQueries({queryKey:["admin",path]});
    const mutate=async(action:()=>Promise<unknown>)=>{try{await action();await refresh();message.success("操作成功");return true;}catch(error){message.error(error instanceof Error?error.message:"操作失败");return false;}};
    return {keyword,setKeyword,search:setSearch,query,refresh,mutate};
}
