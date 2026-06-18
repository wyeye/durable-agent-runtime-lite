import { Layout } from 'antd';
import { Outlet } from 'react-router';
import { HeaderBar } from './HeaderBar.js';
import { SideNav } from './SideNav.js';

export function AppLayout() {
  return (
    <Layout className="cp-layout">
      <HeaderBar />
      <Layout>
        <Layout.Sider className="cp-sider" theme="light" width={236} breakpoint="lg" collapsedWidth={0}>
          <SideNav />
        </Layout.Sider>
        <Layout.Content className="cp-content">
          <Outlet />
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
