import { createBrowserRouter, Navigate, Outlet } from "react-router-dom";

import { AnalyticsTracker } from "@/components/layout/analytics-tracker";
import UserLayout from "@/layouts/user-layout";
import AssetsPage from "@/pages/assets";
import AccountPage from "@/pages/account";
import AdminLayout from "@/layouts/admin-layout";
import AdminUsersPage from "@/pages/admin/users";
import AdminLogsPage from "@/pages/admin/logs";
import AdminLibraryPage from "@/pages/admin/library";
import CanvasWorkflowPage from "@/pages/canvas/workflow-editor";
import AdminSettingsPage from "@/pages/admin/settings";
import AdminStoragePage from "@/pages/admin/storage";
import AdminSystemChannelPage from "@/pages/admin/system-channel";
import CanvasPage from "@/pages/canvas";
import CanvasProjectPage from "@/pages/canvas/project";
import ConfigPage from "@/pages/config";
import HomePage from "@/pages/home";
import ImagePage from "@/pages/image";
import NotFound from "@/pages/not-found";
import PromptsPage from "@/pages/prompts";
import VideoPage from "@/pages/video";

export const router = createBrowserRouter([
    {
        element: (
            <UserLayout>
                <AnalyticsTracker />
                <Outlet />
            </UserLayout>
        ),
        children: [
            { path: "/", element: <HomePage /> },
            { path: "/image", element: <ImagePage /> },
            { path: "/video", element: <VideoPage /> },
            { path: "/assets", element: <AssetsPage /> },
            { path: "/prompts", element: <PromptsPage /> },
            { path: "/canvas", element: <CanvasPage /> },
            { path: "/canvas/workflow", element: <Navigate to="/canvas/workflow/new" replace /> },
            { path: "/canvas/workflow/new", element: <CanvasWorkflowPage /> },
            { path: "/canvas/workflow/:id", element: <CanvasWorkflowPage /> },
            { path: "/canvas/:id", element: <CanvasProjectPage /> },
            { path: "/config", element: <ConfigPage /> },
            { path: "/account", element: <AccountPage /> },
            { path: "/admin", element: <AdminLayout />, children: [
                { index:true, element:<Navigate to="users" replace/> },
                { path:"users", element:<AdminUsersPage/> },
                { path:"compute-logs", element:<AdminLogsPage key="compute"/> },
                { path:"ai-logs", element:<AdminLogsPage key="ai" details/> },
                { path:"prompts", element:<AdminLibraryPage key="prompts" kind="prompts"/> },
                { path:"tutorials", element:<AdminLibraryPage key="tutorials" kind="tutorials"/> },
                { path:"skills", element:<AdminLibraryPage key="skills" kind="skills"/> },
                { path:"assets", element:<AdminLibraryPage key="assets" kind="assets"/> },
                { path:"settings", element:<AdminSettingsPage/> },
                { path:"storage", element:<AdminStoragePage/> },
                { path:"system-channel", element:<AdminSystemChannelPage key="system-channel"/> },
                { path:"system-channel-models", element:<AdminSystemChannelPage key="system-channel-models" modelsOnly/> },
            ] },
        ],
    },
    { path: "*", element: <NotFound /> },
]);
